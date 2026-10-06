# Boundaries — Parse, Don't Validate

Alexis King, [*Parse, Don't Validate*](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/): a validator inspects data and throws the knowledge away; a parser consumes untrusted input and returns a value whose *type* carries the proof. In `two-track` the parser is a `Decoder<A>`: `unknown` in, `Result<DecodeError, A>` out, every issue reported with its path. **One decoder per entry point, exactly one decode per boundary, zero `as` casts on external data, and nothing past a decoder re-checks.** If you feel the need to re-validate, the boundary is in the wrong place.

Verified against two-track 0.1.0 (October 2026).

## The pattern at every boundary

1. Shape the raw input into a plain value (`JSON.parse` via `D.json`, `Object.fromEntries` for search params, `argv` into a record, `FormData` into a record).
2. Decode it with one `D.struct`/`D.taggedUnion` whose leaves are the domain's branded decoders.
3. On `err`: report *all* issues (`D.formatIssues`) as a 400 / exit 2 / dead-letter. On `ok`: hand the domain type to the workflow and never look at the raw input again.

Decoders **accumulate** — a struct with three bad fields reports three issues — because boundaries should show every problem at once. Issues carry `path` and `message`, never the offending value, so a failed decode of a secret cannot leak it into logs.

## HTTP request body

```ts
import { D, R, type Infer, type Result } from "two-track";
import { Email, Quantity, UserId } from "./brands.ts";

// One decoder per entry point. Unknown keys are ignored; every issue is reported with its path.
export const PlaceOrderBody = D.json(
  D.struct({
    userId: UserId,
    email: Email,
    lines: D.nonEmptyArray(D.struct({ sku: D.pattern(/^[A-Z]{3}-\d{3}$/, "expected SKU like ABC-123"), qty: Quantity })),
    coupon: D.option(D.nonEmptyString),  // null | undefined | absent → Option
    note: D.optional(D.string),          // key may be absent → `note?: string`
  }),
);
export type PlaceOrder = Infer<typeof PlaceOrderBody>;

type Response = { readonly status: number; readonly body: string };

// The handler: decode once, hand domain types to the workflow, map the error track to a status.
export const handle = (rawBody: string, run: (cmd: PlaceOrder) => Result<{ readonly _tag: "Rejected" }, { readonly id: string }>): Response => {
  const decoded = PlaceOrderBody.decode(rawBody);
  if (!decoded.ok) return { status: 400, body: D.formatIssues(decoded.error) };
  return R.match(
    run(decoded.value),
    (order) => ({ status: 201, body: JSON.stringify(order) }),
    () => ({ status: 422, body: "rejected" }),
  );
};
```

- `D.json` parses and decodes in one step; a malformed body is the issue `$: expected valid JSON`, not an exception.
- `D.struct` ignores unknown keys and only ever emits declared ones, so nothing unvalidated leaks through. If a client sending extra keys must be an error for your API, add `D.refine` over `D.record(D.unknown)` first.
- `D.option` vs `D.optional`: `option` maps `null | undefined | absent` to `Option<A>` (domain-friendly); `optional` keeps `A | undefined` with an optional key (wire-friendly, for DTOs you re-encode).

## Query and path parameters

Everything arrives as a string. Decode the string, then transform fallibly with `D.andThen`; the string you return is the issue message.

```ts
import { D, ok, err, type Infer } from "two-track";
import { UserId } from "./brands.ts";

// Query and path params arrive as strings. Decode the string, then transform fallibly with D.andThen.
const intFromString = D.andThen(D.string, (s) => {
  const n = Number(s);
  return /^-?\d+$/.test(s) && Number.isSafeInteger(n) ? ok(n) : err("expected integer");
});

export const Pagination = D.struct({
  page: D.optional(D.map(D.min(intFromString, 1), (n) => n)),
  pageSize: D.optional(D.max(D.min(intFromString, 1), 100)),
});
export type Pagination = Infer<typeof Pagination>;

export const PathParams = D.struct({ userId: UserId });

// A URLSearchParams is not a plain object; shape it first, then decode.
export const fromSearchParams = (sp: URLSearchParams): Record<string, string> => Object.fromEntries(sp.entries());

export const withDefaults = (p: Pagination): { readonly page: number; readonly pageSize: number } => ({ page: p.page ?? 1, pageSize: p.pageSize ?? 20 });
```

## Environment and configuration

Decode `process.env` **once**, in `main.ts`, into a typed `Config` that is passed down through `deps`. Nothing else reads `process.env` (`two-track-check`'s `no-process-env` rule reports any read outside the composition root). Defaults are `D.map` over an `optional` field. Secrets are a brand whose only producer is this decoder.

```ts
import { D, type Infer } from "two-track";

// Secrets are a brand whose only legal producer is the env decoder. DecodeIssue carries path + message,
// never the value, so a failed decode cannot leak a secret into logs.
export const Redacted = D.brand(D.nonEmptyString, "Redacted");
export type Redacted = Infer<typeof Redacted>;
export const reveal = (r: Redacted): string => r; // call sites are grep-able

const Port = D.andThen(D.string, (s) => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? { ok: true, value: n } : { ok: false, error: "expected port 1-65535" };
});

// Decode process.env ONCE in main.ts. Defaults are applied by D.map over an optional field.
export const Config = D.struct({
  DATABASE_URL: Redacted,
  PORT: D.map(D.optional(Port), (p) => p ?? 3000),
  LOG_LEVEL: D.map(D.optional(D.literal("debug", "info", "warn", "error")), (l) => l ?? "info"),
  SHUTDOWN_GRACE_MS: D.map(D.optional(D.andThen(D.string, (s) => ({ ok: true, value: Number(s) }))), (n) => n ?? 10_000),
});
export type Config = Infer<typeof Config>;

export const loadConfig = (env: NodeJS.ProcessEnv): ReturnType<typeof Config.decode> => Config.decode(env);
```

A `Redacted` value is a string at runtime; the brand makes every use site (`reveal(...)`) visible to a grep and keeps secrets out of `JSON.stringify(config)` by convention — never log the config object, log the decoded non-secret fields you choose.

## Database rows — the anti-corruption layer

One row decoder per query shape, living in `infra/db/`. The repository decodes the driver's `unknown[]` and translates both driver failures and schema drift into tagged errors. A row that fails to decode is a *bug* (migration drift), reported with its path, not silently skipped.

```ts
import { Async, D, tagged, type AsyncResult, type Infer } from "two-track";
import { Cents, UserId } from "./brands.ts";
import { Instant } from "./time.ts";

// infra/db/orders.ts — one row decoder per query shape; the repository is the anti-corruption layer.
export const OrderRow = D.struct({
  id: D.string,
  user_id: UserId,
  total_cents: Cents,
  shipped_at: D.option(Instant),   // NULL → none
  created_at: Instant,
});
export type OrderRow = Infer<typeof OrderRow>;

export const RowDecodeFailed = tagged("RowDecodeFailed")<{ table: string; issues: string }>();
export const DbUnavailable = tagged("DbUnavailable")<{ cause: unknown }>();
type RepoError = ReturnType<typeof RowDecodeFailed> | ReturnType<typeof DbUnavailable>;

type Driver = { readonly query: (sql: string, params: ReadonlyArray<unknown>) => Promise<ReadonlyArray<unknown>> };

export const listOrders = (db: Driver) => async (userId: UserId): AsyncResult<RepoError, ReadonlyArray<OrderRow>> => {
  const rows = await Async.fromPromise(db.query("select * from orders where user_id = $1", [userId]), (cause) => DbUnavailable({ cause }));
  if (!rows.ok) return rows;
  // A row that fails to decode is a schema drift bug: report it as its own tagged error, with the path.
  const decoded = D.array(OrderRow).decode(rows.value);
  return decoded.ok ? decoded : { ok: false, error: RowDecodeFailed({ table: "orders", issues: D.formatIssues(decoded.error) }) };
};
```

Timestamps: configure the driver to return ISO strings (or decode `Date` with `D.custom`) and brand them as `Instant` here, so the domain never sees `Date`. Nullable columns are `D.option`. Column names stay snake_case in the row type; renaming happens in the `fromRow` conversion (`references/domain-types.md`). More in `references/database.md`.

## CLI arguments

```ts
import { D, ok, err, type Infer } from "two-track";

// CLI: shape argv into a record (`--key=value`, `--key value`, `--flag`), then decode it like any other boundary.
declare const parseArgv: (argv: ReadonlyArray<string>) => Record<string, string | true>;

const flag = D.map(D.optional(D.literal(true)), (v) => v === true);
const Count = D.andThen(D.string, (s) => (/^\d+$/.test(s) ? ok(Number(s)) : err("expected a non-negative integer")));

export const Args = D.struct({
  input: D.nonEmptyString,
  format: D.map(D.optional(D.literal("json", "csv")), (f) => f ?? "json"),
  limit: D.optional(Count),
  verbose: flag,
});
export type Args = Infer<typeof Args>;

export const readArgs = (argv: ReadonlyArray<string>): ReturnType<typeof Args.decode> => Args.decode(parseArgv(argv));
```

On `err`, print `D.formatIssues` and exit 2 (usage error), distinct from exit 1 (runtime failure). Sub-commands are a `D.taggedUnion` on the first positional, exactly like queue messages below.

## Queue messages and versioned wire unions

Messages are a tagged union on `type`. **Versions are variants too**: a new producer adds `order.placed.v2`; old consumers keep decoding v1; the edge normalizes both into one domain event so workflows never see versions.

```ts
import { D, matchBy, type Infer, type Option } from "two-track";
import { none, some } from "two-track";
import { Cents, UserId } from "./brands.ts";
import { Instant } from "./time.ts";

// Queue messages are a tagged union on `type`; versions are variants too, so old producers keep working.
export const OrderMessage = D.taggedUnion("type", {
  "order.placed.v1": D.struct({ type: D.literal("order.placed.v1"), orderId: D.string, userId: UserId, totalCents: Cents }),
  "order.placed.v2": D.struct({ type: D.literal("order.placed.v2"), orderId: D.string, userId: UserId, totalCents: Cents, placedAt: Instant }),
  "order.cancelled.v1": D.struct({ type: D.literal("order.cancelled.v1"), orderId: D.string, reason: D.string }),
});
export type OrderMessage = Infer<typeof OrderMessage>;

// Normalize versions at the edge so the workflow sees ONE domain event. matchBy is exhaustive on `type`.
export type OrderEvent =
  | { readonly _tag: "Placed"; readonly orderId: string; readonly userId: UserId; readonly total: Cents; readonly placedAt: Option<Instant> }
  | { readonly _tag: "Cancelled"; readonly orderId: string; readonly reason: string };

export const toEvent = (m: OrderMessage): OrderEvent =>
  matchBy<"type", OrderMessage, OrderEvent>("type", m, {
    "order.placed.v1": (v) => ({ _tag: "Placed", orderId: v.orderId, userId: v.userId, total: v.totalCents, placedAt: none }),
    "order.placed.v2": (v) => ({ _tag: "Placed", orderId: v.orderId, userId: v.userId, total: v.totalCents, placedAt: some(v.placedAt) }),
    "order.cancelled.v1": (v) => ({ _tag: "Cancelled", orderId: v.orderId, reason: v.reason }),
  });

// The consumer: raw bytes → JSON → message → event. A bad message is a dead-letter, with the path in the issue.
export const decodeMessage = D.json(OrderMessage);
```

`D.taggedUnion` reads the discriminant first and reports the issues of the one matching variant; an unknown `type` is the single issue `type: expected one of …`. Use the same shape for webhooks, SSE events, and `postMessage` payloads.

## Browser: forms and the DOM

The browser is a boundary like any other. `FormData`, `dataset`, `localStorage`, and `postMessage` all yield strings or `unknown`; shape, then decode.

```ts
import { D, type Infer } from "two-track";
import { Email } from "./brands.ts";

// Browser: FormData and DOM values are strings or null. Shape, then decode — same rule as the server.
export const SignupForm = D.struct({
  email: Email,
  name: D.minLength(D.trimmed, 1),
  newsletter: D.map(D.optional(D.literal("on")), (v) => v === "on"),
});
export type SignupForm = Infer<typeof SignupForm>;

export const fromFormData = (fd: FormData): Record<string, string> => {
  const out: Record<string, string> = {};
  fd.forEach((value, key) => {
    if (typeof value === "string") out[key] = value;
  });
  return out;
};

export const readSignup = (form: HTMLFormElement): ReturnType<typeof SignupForm.decode> => SignupForm.decode(fromFormData(new FormData(form)));
```

## Encoding — the reverse boundary

Output is a boundary too. Encoding is a plain total function from the domain type to a wire type **owned by the adapter**: brands become primitives, `Option` becomes `null`, `Instant` becomes ISO, and fields that must not leave the process are simply absent.

```ts
import { O } from "two-track";
import type { Cents, Email, UserId } from "./brands.ts";
import type { Instant } from "./time.ts";
import { toIso } from "./time.ts";

type Order = { readonly id: string; readonly userId: UserId; readonly email: Email; readonly total: Cents; readonly shippedAt: O.Option<Instant> };

// Encoding is the reverse boundary: a plain total function from domain to wire shape.
// The wire type is owned by the adapter; brands become primitives, Options become null, Instants become ISO.
export type OrderResponse = { readonly id: string; readonly userId: string; readonly totalCents: number; readonly shippedAt: string | null };

export const encodeOrder = (o: Order): OrderResponse => ({
  id: o.id,
  userId: o.userId,
  totalCents: o.total,
  shippedAt: O.toNullable(O.map(o.shippedAt, toIso)),
});
// Note what is NOT here: `email`. The response shape decides what leaves the process, field by field.
```

Never `JSON.stringify` a domain object directly: it serializes every field, including ones added later. Round-trip property tests (`decode(encode(x)) == x` for the fields that round-trip) are the contract between the two directions (`references/testing.md`).

## Recursive wire shapes

```ts
import { D, type Decoder } from "two-track";

// Recursive JSON (categories, comment threads, ASTs): declare the type, then D.lazy.
export type Category = { readonly name: string; readonly children: ReadonlyArray<Category> };

export const Category: Decoder<Category> = D.lazy(() => D.struct({ name: D.nonEmptyString, children: D.array(Category) }));

export const depth = (c: Category): number => 1 + Math.max(0, ...c.children.map(depth));
```

## Dates on the wire

`D.isoDate` is strict: `YYYY-MM-DD` or a date-time with `Z`/`±HH:mm`, calendar-checked, offset required for date-times because a wall-clock time without a zone means nothing on a wire. If a producer sends `March 5, 2020` or `2023-02-30`, decoding fails and that is the point. When you must accept a sloppy producer, say so in the decoder's name: `D.dateFromString` is the engine's permissive grammar, and it belongs in that producer's adapter, never in a shared wire schema. Store instants as epoch milliseconds (`Instant` brand, `references/domain-types.md`), not `Date` objects.

## When a boundary is hot

Decoders cost roughly 0.3–0.7 µs per object interpreted, which is invisible behind any I/O. When a boundary is genuinely CPU-bound — a bulk import, a stream consumer, a cache rebuild — compile the decoder once at module level and keep the same name discipline:

```ts
import { D, type Infer } from "two-track";

export const ImportRow = D.struct({ sku: D.pattern(/^[A-Z]{3}-\d{3}$/), qty: D.min(D.integer, 1), price: D.min(D.integer, 0) });
export type ImportRow = Infer<typeof ImportRow>;
// Same semantics, property-tested equivalent; literal-key code where `new Function` is allowed, the interpreter where it is not.
export const ImportRowFast = D.compile(ImportRow);
```

Call `ImportRowFast.decode` on the hot path and `ImportRow` everywhere else; they are interchangeable. Do not compile in a loop or per request — compilation is a one-time cost — and measure before adopting it in edge runtimes, where it silently falls back (`references/performance.md`).

Place the `compile` call in the module that uses it on the hot path, not in a shared domain file: a browser bundle that imports the domain module for its types and decoders would otherwise carry the 4 kB compiler for a call it never makes (esbuild does not drop an unused export of a local module even with `/* @__PURE__ */`). The proof repo's edge app shrank its client bundle by a third by moving one `D.compile` from `domain/catalog.ts` to `workflows/search.ts`.

## Checklist

- [ ] A hot boundary (bulk import, stream, cache rebuild) uses `D.compile(decoder)` created once at module level; everything else uses the interpreter
- [ ] Every entry point (body, params, env, row, argv, message, form) has exactly one decoder; no `as` on external data
- [ ] Nothing past a decoder re-checks (`typeof`, `!= null`, regex) — if it does, move the boundary
- [ ] Decode errors are reported in full with `D.formatIssues` (400 / exit 2 / dead-letter); issues never contain values
- [ ] `process.env` is decoded once in `main.ts`; secrets are `Redacted`; defaults via `D.map(D.optional(...))`
- [ ] Row decoders live in `infra/db/`; nullable columns are `D.option`; decode failure is `RowDecodeFailed`, not a skip
- [ ] Wire unions use `D.taggedUnion`; versions are variants normalized at the edge with `matchBy`
- [ ] Output goes through an explicit encode function to an adapter-owned wire type; no `JSON.stringify(domainValue)`
- [ ] Recursive shapes use `D.lazy` with an explicit `Decoder<T>` annotation
