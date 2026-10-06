# Capabilities and Dependency Injection — Ports, the `Deps` Record, One Composition Root

TypeScript without a runtime has no requirements channel: there is no `R` in the type, no `Layer`, and no trait resolver. Do not build one — a Reader closure per call is a runtime, and its types stop composing at the first `await`. The substitute is boring and fast: **every effect a workflow needs is an interface (a port), the workflow takes a record of them as its first argument, and exactly one file names the implementations.** The library ships the four capabilities every application needs (`Cap.Clock`, `Cap.Sleeper`, `Cap.Random`, `Cap.IdGen`) with production and deterministic implementations; everything else is yours.

Verified against two-track 0.1.0 (October 2026).

## 1. Ports live with the consumer; implementations live in `infra/`

```
src/domain/ports.ts     OrderRepo, Payments, Mailer, …   ← interfaces, domain error types
src/infra/pg/…          pgOrderRepo(pool): OrderRepo      ← implementations
src/main.ts             const deps: Deps = { … }          ← the only naming site
```

Port methods return **domain** errors and take an `AbortSignal` last. A driver's error type never appears in a port signature; the adapter wraps it as `cause: unknown` inside a tagged error.

```ts
import { D, tagged, type AsyncResult, type Brand, type Cap, type Infer, type Option } from "two-track";

// domain/types.ts — brands come from decoders
export const OrderId = D.brand(D.pattern(/^ord_[a-z0-9]+$/), "OrderId");
export const UserId = D.brand(D.nonEmptyString, "UserId");
export const Cents = D.brand(D.min(D.integer, 0), "Cents");
export type OrderId = Infer<typeof OrderId>;
export type UserId = Infer<typeof UserId>;
export type Cents = Infer<typeof Cents>;
export type Order = { readonly id: OrderId; readonly userId: UserId; readonly total: Cents; readonly placedAt: number };

// domain/errors.ts
export const RepoError = tagged("RepoError")<{ op: string; cause: unknown }>();
export const PaymentDeclined = tagged("PaymentDeclined")<{ reason: string; retriable: boolean }>();
export type RepoError = ReturnType<typeof RepoError>;
export type PaymentDeclined = ReturnType<typeof PaymentDeclined>;

// domain/ports.ts — every method: (args, signal) => AsyncResult<PortError, A>
export type OrderRepo = {
  readonly findById: (id: OrderId, signal: AbortSignal) => AsyncResult<RepoError, Option<Order>>;
  readonly insert: (order: Order, signal: AbortSignal) => AsyncResult<RepoError, void>;
};
export type Payments = {
  readonly charge: (userId: UserId, amount: Cents, signal: AbortSignal) => AsyncResult<PaymentDeclined, void>;
};

// The capability record. Library capabilities and your ports side by side.
export type Deps = {
  readonly orders: OrderRepo;
  readonly payments: Payments;
  readonly clock: Cap.Clock;
  readonly sleeper: Cap.Sleeper;
  readonly random: Cap.Random;
  readonly ids: Cap.IdGen;
  readonly log: (event: string, fields: Readonly<Record<string, unknown>>) => void;
};

// Secrets: a brand whose decoder never puts the value in an issue message.
export type Redacted = Brand<string, "Redacted">;
export const Redacted = D.brand(D.refine(D.string, (s) => s.length > 0, "expected non-empty secret"), "Redacted");
```

Why a record and why first: one parameter instead of six keeps signatures stable as needs change; putting it first makes `deps` visually the "environment" and the command the "input", and lets you `Pick` a narrower view per workflow.

## 2. Workflows name exactly what they use

A workflow that takes the whole `Deps` claims every capability. Narrow with `Pick` so the signature is the requirements list — the closest TypeScript gets to Effect's `R` — and a test fixture supplying only those keys compiles.

Request-scoped values (request id, trace id, the request's `AbortSignal`) are **not** ambient: they travel in an explicit `ctx` argument.

```ts
import { Async, O, ok, err, type AsyncResult } from "two-track";
import { type Deps, type Order, type OrderId, type RepoError, type PaymentDeclined } from "./ports.ts";

export type PayOrderDeps = Pick<Deps, "orders" | "payments" | "clock" | "sleeper" | "random" | "log">;
// The retry below takes the request signal, so cancellation is a named outcome of this workflow, not a guess from the last error.
export type PayOrderError = RepoError | PaymentDeclined | Async.Aborted | { readonly _tag: "OrderNotFound"; readonly orderId: OrderId };

export type Ctx = { readonly requestId: string; readonly signal: AbortSignal };

export const payOrder = async (deps: PayOrderDeps, ctx: Ctx, orderId: OrderId): AsyncResult<PayOrderError, Order> => {
  const found = await deps.orders.findById(orderId, ctx.signal);
  if (!found.ok) return found;
  if (!O.isSome(found.value)) return err({ _tag: "OrderNotFound" as const, orderId });
  const order = found.value.value;

  const charged = await Async.retry((_, signal) => deps.payments.charge(order.userId, order.total, signal), {
    attempts: 3,
    delay: Async.backoff({ baseMs: 100, maxMs: 1_000, random: deps.random.next }),
    retriable: (e) => e.retriable,
    sleeper: deps.sleeper,
    signal: ctx.signal,
  });
  if (!charged.ok) return charged;

  deps.log("order.paid", { requestId: ctx.requestId, orderId, at: deps.clock.now() });
  return ok(order);
};
```

Pure helpers take no `deps`. If a calculation needs a capability to be tested, it is in the wrong layer — move the decision into the domain and pass the value in.

## 3. Fakes are plain objects

No mocking library. A fake is an object literal implementing the port; its state lives in a closure. The library's deterministic capabilities cover time, sleep, randomness, and ids.

```ts
import { Cap, O, ok, type AsyncResult } from "two-track";
import type { Deps, Order, OrderId, OrderRepo, Payments, RepoError } from "./ports.ts";

export const inMemoryOrders = (seed: ReadonlyArray<Order> = []): OrderRepo & { readonly all: () => ReadonlyArray<Order> } => {
  const rows = new Map<OrderId, Order>(seed.map((o) => [o.id, o]));
  return {
    all: () => [...rows.values()],
    findById: async (id) => ok(O.fromNullable(rows.get(id))),
    insert: async (order) => {
      rows.set(order.id, order);
      return ok(undefined);
    },
  };
};

export const alwaysApproves = (): Payments & { readonly charges: ReadonlyArray<number> } => {
  const charges: number[] = [];
  return { charges, charge: async (_u, amount) => { charges.push(amount); return ok(undefined); } };
};

export const testDeps = (overrides: Partial<Deps> = {}): Deps => ({
  orders: inMemoryOrders(),
  payments: alwaysApproves(),
  clock: Cap.controlledClock(1_700_000_000_000),
  sleeper: Cap.instantSleeper(),
  random: Cap.seededRandom(42),
  ids: Cap.sequentialIds("ord_"),
  log: () => undefined,
  ...overrides,
});

// A failing fake for the error track
export const brokenOrders: OrderRepo = {
  findById: async (): AsyncResult<RepoError, never> => ({ ok: false, error: { _tag: "RepoError", op: "findById", cause: "connection refused" } }),
  insert: async (): AsyncResult<RepoError, never> => ({ ok: false, error: { _tag: "RepoError", op: "insert", cause: "connection refused" } }),
};
```

`testDeps({ orders: brokenOrders })` tests the repo-failure track; `Cap.instantSleeper().calls` asserts the backoff schedule; `Cap.controlledClock(...).advance(ms)` drives time-dependent decisions. See `testing.md`.

## 4. The composition root

`main.ts` is the only file that reads `process.env`, constructs drivers, and names adapters. Config is decoded once with `D.struct`; secrets are `Redacted` so a decode failure never echoes a value. Resources opened here are closed here, in reverse, on shutdown.

```ts
import { Cap, D, type AsyncResult, type Infer } from "two-track";
import { Redacted, type Deps, type OrderRepo, type Payments } from "./domain/ports.ts";

const Config = D.struct({
  PORT: D.map(D.pattern(/^\d+$/), Number),
  DATABASE_URL: Redacted,
  STRIPE_KEY: Redacted,
  LOG_LEVEL: D.literal("debug", "info", "warn"),
});
export type Config = Infer<typeof Config>;

type Pool = { readonly query: (sql: string, params: ReadonlyArray<unknown>) => Promise<{ rows: unknown[] }>; readonly end: () => Promise<void> };
declare const createPool: (url: string) => Pool;
declare const pgOrderRepo: (pool: Pool) => OrderRepo;
declare const stripePayments: (key: string, fetchImpl: typeof fetch) => Payments;
declare const serve: (deps: Deps, port: number, signal: AbortSignal) => AsyncResult<never, void>;

export const main = async (): Promise<number> => {
  const config = Config.decode(process.env);
  if (!config.ok) {
    console.error(`invalid configuration: ${D.formatIssues(config.error)}`); // never prints values
    return 1;
  }

  const disposers: Array<() => Promise<void>> = [];
  const pool = createPool(config.value.DATABASE_URL);
  disposers.push(() => pool.end());

  const deps: Deps = {
    orders: pgOrderRepo(pool),
    payments: stripePayments(config.value.STRIPE_KEY, fetch),
    clock: Cap.systemClock,
    sleeper: Cap.systemSleeper,
    random: Cap.systemRandom,
    ids: Cap.systemIdGen,
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
  };

  const shutdown = new AbortController();
  process.once("SIGTERM", () => shutdown.abort());
  process.once("SIGINT", () => shutdown.abort());

  await serve(deps, config.value.PORT, shutdown.signal);
  for (const dispose of disposers.reverse()) await dispose();
  return 0;
};
```

The `declare const` lines stand in for the real `infra/` modules. `main.ts` is allowed to use `console`, `process`, and drivers; nothing else is.

## 5. Scoping and lifecycles

| Scope | Where it lives | How it ends |
|---|---|---|
| Process (pool, HTTP client, queue connection) | opened in `main.ts`, held in `deps` | `disposers` run in reverse on the shutdown signal |
| Request (request id, deadline, auth subject) | an explicit `ctx` argument | the request's `AbortSignal` aborts; nothing to dispose |
| Transaction (tx-scoped repositories) | a `withTransaction(signal, body)` port on `deps` that hands `body` a repos record bound to the connection | ok commits, err rolls back — see `database.md` |
| Per-call temporaries (an `AbortController` for a timeout) | inside the combinator (`Async.withTimeout`) | the combinator clears it |

Never store request-scoped values in module state or `AsyncLocalStorage` to avoid threading them: implicit context is exactly what makes a function's requirements illegible.

## 6. Compared with Effect and Rust

| Concern | Effect | Rust (rust-fp-skill) | two-track |
|---|---|---|---|
| Declaring a dependency | `R` type parameter | trait bound / `&dyn Trait` | key in the `Deps` record; `Pick<Deps, …>` per workflow |
| Providing it | `Layer` graph, memoized | constructor in `main.rs` | object literal in `main.ts` |
| Enforcing the domain stays pure | `R = never` | cargo: the crate has no deps | grep: `domain/` imports only `two-track` (`code-review.md`) |
| Test double | test `Layer` | hand-written `impl` | object literal implementing the port |
| Request scope | `FiberRef` / context | parameter | explicit `ctx` parameter |
| Cost | runtime resolution per effect | zero | zero (a property read) |

## Checklist

- [ ] Every port is an interface in `domain/ports.ts`; methods take `signal: AbortSignal` last and return `AsyncResult<DomainError, A>`
- [ ] No driver or SDK error type appears in a port signature; adapters wrap as `cause: unknown`
- [ ] Workflows take `deps` first and narrow it with `Pick` to exactly what they use
- [ ] Request-scoped values travel in an explicit `ctx`; nothing is ambient
- [ ] `process.env`, `console`, drivers, and `Cap.system*` are referenced only in `main.ts` and `infra/`
- [ ] Config is decoded once with `D.struct`; secrets are `Redacted`
- [ ] Exactly one composition root; resources it opens are closed by its `disposers`
- [ ] Fakes are object literals; tests use `controlledClock`, `instantSleeper`, `seededRandom`, `sequentialIds`
- [ ] Pure helpers take no `deps`
