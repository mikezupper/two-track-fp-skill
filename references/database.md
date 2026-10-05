# Database — Repositories as Ports, Row Decoders, Workflow-Owned Transactions

Persistence is infrastructure behind a port. A repository is an object implementing an interface from `domain/ports.ts`; it returns `AsyncResult` with **domain** errors, decodes every row at the boundary, and performs the driver interop (`Async.tryPromise`) exactly once in a shared helper. Transactions belong to the workflow, not the repository: the workflow decides what must be atomic, and the error track rolls back. Examples stub `pg` with a two-method `Pool` type; swap in the real driver in `infra/` without changing anything above it.

Verified against two-track 0.1.0 (October 2026).

## 1. Ports, errors, and the row decoder

```ts
import { Async, D, O, R, ok, err, tagged, type AsyncResult, type Infer, type Option } from "two-track";

// domain/types.ts
export const UserId = D.brand(D.pattern(/^usr_[a-z0-9]+$/), "UserId");
export const Email = D.brand(D.pattern(/^[^\s@]+@[^\s@]+$/, "expected email"), "Email");
export type UserId = Infer<typeof UserId>;
export type Email = Infer<typeof Email>;
export type User = { readonly id: UserId; readonly email: Email; readonly createdAt: Date; readonly deactivatedAt: Option<Date> };

// domain/errors.ts — the driver's error is wrapped as `cause: unknown`, never typed as pg's error
export const RepoError = tagged("RepoError")<{ op: string; cause: unknown }>();
export const EmailTaken = tagged("EmailTaken")<{ email: Email }>();
export type RepoError = ReturnType<typeof RepoError>;
export type EmailTaken = ReturnType<typeof EmailTaken>;

// domain/ports.ts
export type UserRepo = {
  readonly findById: (id: UserId, signal: AbortSignal) => AsyncResult<RepoError, Option<User>>;
  readonly findManyByIds: (ids: ReadonlyArray<UserId>, signal: AbortSignal) => AsyncResult<RepoError, ReadonlyArray<User>>;
  readonly insert: (user: User, signal: AbortSignal) => AsyncResult<RepoError | EmailTaken, void>;
};

// infra/pg/user-row.ts — the row decoder is the boundary; the wire shape is not the domain shape
export const UserRow = D.struct({
  id: UserId,
  email: Email,
  created_at: D.isoDate,
  deactivated_at: D.option(D.isoDate),
});
export type UserRow = Infer<typeof UserRow>;
export const rowToUser = (r: UserRow): User => ({ id: r.id, email: r.email, createdAt: r.created_at, deactivatedAt: r.deactivated_at });
```

- `RepoError` is for failures the caller cannot act on specifically (connection lost, syntax error, unexpected row shape); it carries the `op` name for logs and the raw `cause` for the edge to inspect. Failures a caller *can* act on (`EmailTaken`, `UserNotFound`) are their own tags, decided inside the adapter.
- Nullable columns decode to `Option` with `D.option`; ids are brands; timestamps are `D.isoDate` (when the driver yields ISO strings) or `D.integer` (epoch millis). If the driver already returns `Date` objects, use `D.custom((u): u is Date => u instanceof Date, "Date")`.
- Column names stay snake_case in the row type; `rowToUser` is the one place they become domain names. Separate row types per query when the projections differ.

## 2. The interop edge, once

```ts
import { Async, D, R, tagged, type AsyncResult } from "two-track";
import { RepoError } from "./errors.ts";

// infra/pg/pool.ts — stubbed pg; one interop edge for the whole adapter layer
export type Pool = { readonly query: (sql: string, params: ReadonlyArray<unknown>) => Promise<{ rows: unknown[] }> };
export type Queryable = Pick<Pool, "query">;

export const query = (db: Queryable, op: string, sql: string, params: ReadonlyArray<unknown>, signal: AbortSignal): AsyncResult<RepoError, unknown[]> =>
  Async.map(
    Async.tryPromise(() => db.query(sql, params), (cause) => RepoError({ op, cause }), signal),
    (res) => res.rows,
  );

export const decodeRows = <A>(op: string, decoder: D.Decoder<A>, rows: unknown[]) =>
  R.mapErr(R.traverse(rows, (row) => decoder.decode(row)), (e) => RepoError({ op, cause: D.formatIssues(e) }));
```

`query` is the only `tryPromise` in the persistence layer. Parameters are always bound (`$1`), never interpolated. Pass the `signal` through; with the real `pg` client, cancellation is implemented by issuing `pg_cancel_backend` from a signal listener in this helper, and nowhere else.

## 3. A repository

```ts
import { Async, O, R, ok, err } from "two-track";
import { EmailTaken, UserRow, rowToUser, type UserRepo } from "./user-row.ts";
import { decodeRows, query, type Queryable } from "./pool.ts";

const isUniqueViolation = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505";

export const pgUserRepo = (db: Queryable): UserRepo => ({
  findById: (id, signal) =>
    Async.andThen(query(db, "users.findById", "select id, email, created_at, deactivated_at from users where id = $1", [id], signal), (rows) =>
      R.map(decodeRows("users.findById", UserRow, rows), (users) => O.map(O.fromNullable(users[0]), rowToUser)),
    ),

  // One query for a collection, never N+1.
  findManyByIds: (ids, signal) =>
    ids.length === 0
      ? Promise.resolve(ok([]))
      : Async.andThen(query(db, "users.findManyByIds", "select id, email, created_at, deactivated_at from users where id = any($1)", [ids], signal), (rows) =>
          R.map(decodeRows("users.findManyByIds", UserRow, rows), (users) => users.map(rowToUser)),
        ),

  // Unique violation → domain error, decided INSIDE infra by the driver's code.
  insert: async (user, signal) => {
    const r = await query(
      db,
      "users.insert",
      "insert into users (id, email, created_at, deactivated_at) values ($1, $2, $3, $4)",
      [user.id, user.email, user.createdAt.toISOString(), O.toNullable(O.map(user.deactivatedAt, (d) => d.toISOString()))],
      signal,
    );
    if (r.ok) return ok(undefined);
    return isUniqueViolation(r.error.cause) ? err(EmailTaken({ email: user.email })) : r;
  },
});
```

- `pgUserRepo(db)` takes a `Queryable`, so the same factory binds to a pool **or** a transaction client (next section).
- Translating `23505` to `EmailTaken` is the adapter's job because only it knows the driver. The workflow sees `RepoError | EmailTaken` and matches on it.
- `findManyByIds` with `= any($1)` is the shape for every "load these N" call. A loop calling `findById` is an N+1 and a review failure.
- `O.toNullable` on the way out and `D.option` on the way in are the only places `null` exists.

## 4. Transactions — the workflow owns the boundary

A `WithTransaction` port runs a function with tx-scoped repositories. The function's `Result` decides the outcome: `Ok` commits, `Err` rolls back, and the error flows out unchanged. Repositories never call `begin`/`commit`.

```ts
import { Async, ok, type AsyncResult } from "two-track";
import { pgUserRepo } from "./user-repo.ts";
import { query, type Pool, type Queryable } from "./pool.ts";
import type { RepoError, UserRepo } from "./user-row.ts";

export type TxRepos = { readonly users: UserRepo };
export type WithTransaction = <E, A>(run: (repos: TxRepos, signal: AbortSignal) => AsyncResult<E, A>, signal: AbortSignal) => AsyncResult<E | RepoError, A>;

type PoolWithClients = Pool & { readonly connect: () => Promise<Queryable & { readonly release: () => void }> };

export const pgWithTransaction = (pool: PoolWithClients): WithTransaction => async (run, signal) => {
  const client = await Async.tryPromise(() => pool.connect(), (cause) => ({ _tag: "RepoError" as const, op: "tx.connect", cause }), signal);
  if (!client.ok) return client;
  const c = client.value;

  const begun = await query(c, "tx.begin", "begin", [], signal);
  if (!begun.ok) {
    c.release();
    return begun;
  }

  const outcome = await run({ users: pgUserRepo(c) }, signal);
  const finish = outcome.ok ? await query(c, "tx.commit", "commit", [], signal) : await query(c, "tx.rollback", "rollback", [], signal);
  c.release();
  if (!finish.ok) return finish;
  return outcome;
};

// workflows/… — the workflow owns the boundary; the repo never calls begin/commit.
type Deps = { readonly withTransaction: WithTransaction };
export const transferOwnership = (deps: Deps, signal: AbortSignal) =>
  deps.withTransaction(async (repos, s) => {
    const a = await repos.users.findManyByIds([], s);
    if (!a.ok) return a;
    return ok(a.value.length);
  }, signal);
```

Rules: keep the transaction short and free of external calls (no `fetch` inside `run`); do not nest `withTransaction`; anything that must happen after commit (publish an event, send mail) goes through an outbox row written inside the transaction and relayed by a worker (`concurrency.md`). For the error track to be a rollback, every step inside `run` must return its failure rather than swallow it.

## 5. Pagination and migrations

```ts
import { D, R, ok, err, type AsyncResult, type Infer, type Result } from "two-track";
import { query, type Queryable } from "./pool.ts";
import type { RepoError } from "./user-row.ts";

// Pagination: the cursor is opaque to clients and decoded like any other boundary value.
const Cursor = D.json(D.struct({ createdAt: D.isoDate, id: D.string }));
export type Cursor = Infer<typeof Cursor>;
export const decodeCursor = (raw: string | undefined): Result<"BadCursor", Cursor | undefined> => {
  if (raw === undefined) return ok(undefined);
  const decoded = Cursor.decode(Buffer.from(raw, "base64url").toString("utf8"));
  return decoded.ok ? decoded : err("BadCursor");
};
export const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify({ createdAt: c.createdAt.toISOString(), id: c.id })).toString("base64url");

// infra/pg/migrate.ts — plain SQL files, applied in order, recorded in a table.
export const migrate = async (db: Queryable, files: ReadonlyArray<{ name: string; sql: string }>, signal: AbortSignal): AsyncResult<RepoError, number> => {
  const ensure = await query(db, "migrate.ensure", "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())", [], signal);
  if (!ensure.ok) return ensure;
  const applied = await query(db, "migrate.list", "select name from schema_migrations", [], signal);
  if (!applied.ok) return applied;
  const seen = R.traverse(applied.value, (row) => D.struct({ name: D.string }).decode(row));
  if (!seen.ok) return err({ _tag: "RepoError", op: "migrate.list", cause: D.formatIssues(seen.error) });
  const done = new Set(seen.value.map((r) => r.name));
  let count = 0;
  for (const f of files) {
    if (done.has(f.name)) continue;
    const r = await query(db, `migrate.apply:${f.name}`, `${f.sql}; insert into schema_migrations (name) values ('${f.name.replaceAll("'", "''")}')`, [], signal);
    if (!r.ok) return r;
    count++;
  }
  return ok(count);
};
```

Keyset pagination (`where (created_at, id) < ($1, $2) order by created_at desc, id desc limit $3`) over an opaque cursor; never `offset`. Migrations are numbered `.sql` files in `infra/pg/migrations/`, read with `node:fs` in `main.ts` or a `migrate` script, and the only place `sql` is built from strings — the file names are yours, not user input.

## 6. Testing persistence

| Tier | What | How |
|---|---|---|
| Workflows | logic that uses a repo | the in-memory fake from `capabilities-di.md` (a `Map` in a closure); `withTransaction` fake that just calls `run` |
| Row decoders | every `*Row` decoder | fast-check round-trip: generate a domain value, encode to a row shape, decode, compare; plus a fixture of a real row captured once |
| Adapters | SQL and mapping against a real database | a few integration tests on a local Postgres (`DATABASE_URL` env or testcontainers), each in its own transaction that is rolled back, asserting on decoded domain values |
| Error translation | `23505` → `EmailTaken` | insert the same email twice in an integration test; assert the tag |

Integration tests are few and deliberate: they prove the schema, SQL, and decoders agree with reality. Everything else runs against fakes in microseconds.

## Checklist

- [ ] Every repository is an interface in `domain/ports.ts`; methods take `signal` last and return `AsyncResult<RepoError | DomainError, A>`
- [ ] No driver error type anywhere above `infra/`; `RepoError` carries `op` and `cause: unknown`
- [ ] Every row passes through a `D.struct` row decoder; nullable columns are `D.option`; ids are brands
- [ ] Exactly one `Async.tryPromise` for the driver (`query`); parameters are always bound
- [ ] Constraint violations callers can act on are translated to domain tags inside the adapter
- [ ] Collections load with one query (`= any($1)` / `in`), never in a loop
- [ ] Transactions are opened by the workflow through `withTransaction`; repos never `begin`/`commit`; no external calls inside
- [ ] Post-commit effects go through an outbox, not a `.then` after commit
- [ ] Pagination is keyset with an opaque decoded cursor
- [ ] Row decoders have round-trip properties; a handful of integration tests decode real rows
