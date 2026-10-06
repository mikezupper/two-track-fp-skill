# Railway-Oriented Programming with two-track

The two-track model from [fsharpforfunandprofit.com/rop](https://fsharpforfunandprofit.com/rop/): every function is a switch — success continues down the track, failure diverts to the error track and bypasses the remaining steps. In `two-track` the railway is the plain type `Result<E, A> = { ok: true; value: A } | { ok: false; error: E }` and nothing else: no runtime, no class, no generator. The switch is `if (!r.ok) return r;`, which is exactly what Rust's `?` desugars to, and the compiler widens `E` step by step so a signature always lists every failure that can reach a caller.

Verified against two-track 0.1.0 (October 2026).

## Defining errors

One `tagged` constructor per failure mode. The `_tag` is the discriminant that makes `match` exhaustive and `hasTag` precise. Export the constructor and derive the type from it so the two never drift.

```ts
import { tagged, type Tagged } from "two-track";

// One tag per failure mode. The name says WHAT HAPPENED; fields carry what a handler needs.
export const OrderNotFound = tagged("OrderNotFound")<{ orderId: string }>();
export const InsufficientStock = tagged("InsufficientStock")<{ sku: string; requested: number; available: number }>();
export const Timeout = tagged("Timeout")();
export type OrderNotFound = ReturnType<typeof OrderNotFound>;
export type InsufficientStock = ReturnType<typeof InsufficientStock>;
export type Timeout = ReturnType<typeof Timeout>;

// One failure with several causes a caller may react to differently: a nested tagged `reason`.
export type ChargeReason =
  | Tagged<"CardExpired">
  | Tagged<"InsufficientFunds", { shortBy: number }>
  | Tagged<"FraudSuspected", { score: number }>;
export const ChargeFailed = tagged("ChargeFailed")<{ reason: ChargeReason; retriable: boolean }>();
export type ChargeFailed = ReturnType<typeof ChargeFailed>;

export const declined: ChargeFailed = ChargeFailed({ reason: { _tag: "InsufficientFunds", shortBy: 250 }, retriable: false });
export const timedOut: Timeout = Timeout({});
```

Rules: names describe **what happened** (`OrderNotFound`), never who threw (`DbError`); fields carry what a handler needs (ids, the offending value, `retriable`), never only a `message`; one failure with several causes → one tag with a tagged `reason`; namespace tags in large apps (`"orders/PaymentDeclined"`); `E` in every public signature is a union of named tags — never `Error`, `unknown`, `string`, and never `never` (a function that cannot fail returns `A`).

## Composing the synchronous railway

Two forms, same types. **Early return** is the baseline form and the only one allowed on per-element hot paths (`references/performance.md`). **Combinators** allocate one closure per step (measured ~2x) and read well in workflows.

```ts
import { R, err, ok, type Result } from "two-track";
import { InsufficientStock, OrderNotFound } from "./domain-errors.ts";

type Order = { readonly id: string; readonly sku: string; readonly qty: number };
type Stock = Readonly<Record<string, number>>;

const findOrder = (orders: ReadonlyArray<Order>, id: string): Result<OrderNotFound, Order> => {
  const found = orders.find((o) => o.id === id);
  return found === undefined ? err(OrderNotFound({ orderId: id })) : ok(found);
};

const checkStock = (stock: Stock, order: Order): Result<InsufficientStock, Order> => {
  const available = stock[order.sku] ?? 0;
  return order.qty <= available ? ok(order) : err(InsufficientStock({ sku: order.sku, requested: order.qty, available }));
};

// Hot-path form: early return. The error union widens step by step and the signature states it.
export const reserve = (orders: ReadonlyArray<Order>, stock: Stock, id: string): Result<OrderNotFound | InsufficientStock, number> => {
  const order = findOrder(orders, id);
  if (!order.ok) return order;
  const checked = checkStock(stock, order.value);
  if (!checked.ok) return checked;
  return ok(checked.value.qty);
};

// Combinator form: same types, one closure per step. Fine outside per-element loops.
export const reserve2 = (orders: ReadonlyArray<Order>, stock: Stock, id: string): Result<OrderNotFound | InsufficientStock, number> =>
  R.map(
    R.andThen(findOrder(orders, id), (o) => checkStock(stock, o)),
    (o) => o.qty,
  );

// mapErr translates; orElse recovers (deliberately narrowing E); match collapses both tracks.
export const reserveOrZero = (orders: ReadonlyArray<Order>, stock: Stock, id: string): Result<InsufficientStock, number> =>
  R.orElse(reserve(orders, stock, id), (e) => (e._tag === "OrderNotFound" ? ok(0) : err(e)));
```

`R.andThen(a, f)` has error type `EA | EF` — the widening is automatic. `R.orElse` is the only combinator that *narrows* the error type, and it must do so deliberately (the fallback must be genuinely correct, not a way to silence the type). `R.unwrapOr`/`R.unwrapOrElse` collapse to a value and belong at the edge.

## Composing the asynchronous railway

`AsyncResult<E, A>` is `Promise<Result<E, A>>`. **A promise on the railway never rejects**; rejection is reserved for defects. `await` plus early return is the baseline; `Async.andThen` takes a sync or async input and a sync or async next step.

```ts
import { Async, ok, type AsyncResult } from "two-track";
import { InsufficientStock, OrderNotFound } from "./domain-errors.ts";

type Order = { readonly id: string; readonly sku: string; readonly qty: number };
type OrderRepo = { readonly find: (id: string, signal: AbortSignal) => AsyncResult<OrderNotFound, Order> };
type Inventory = { readonly reserve: (sku: string, qty: number, signal: AbortSignal) => AsyncResult<InsufficientStock, void> };
type Deps = { readonly orders: OrderRepo; readonly inventory: Inventory };

// Async railway: await + early return. The promise never rejects; every failure is in the signature.
export const reserveOrder = async (deps: Deps, id: string, signal: AbortSignal): AsyncResult<OrderNotFound | InsufficientStock, Order> => {
  const order = await deps.orders.find(id, signal);
  if (!order.ok) return order;
  const reserved = await deps.inventory.reserve(order.value.sku, order.value.qty, signal);
  if (!reserved.ok) return reserved;
  return ok(order.value);
};

// Async.andThen accepts a sync or async next step and a sync or async input.
export const reserveOrder2 = (deps: Deps, id: string, signal: AbortSignal): AsyncResult<OrderNotFound | InsufficientStock, Order> =>
  Async.andThen(deps.orders.find(id, signal), (order) =>
    Async.map(deps.inventory.reserve(order.sku, order.qty, signal), () => order),
  );
```

There is no do-notation (`yield*`) in this library and none should be hand-rolled: generators measured 40–80x slower than early returns (decision 0002). Early returns are pure and referentially transparent; they are not worse FP.

## Collections on the railway

| You want | Sync | Async | Notes |
|---|---|---|---|
| Several results, first error wins | `R.all([a, b] as const)` (tuple-typed) | `Async.all([pa, pb])` (homogeneous `E`/`A`; for a heterogeneous pair use two `await`s) | only the sync form keeps per-element types |
| Apply `f` to each, stop at first error | `R.traverse(items, f)` | `Async.mapConcurrent(items, f, { concurrency })` | sequential workflows; async version aborts in-flight work |
| Apply `f` to each, report **every** error | `R.validateAll(items, f)` | `Async.validateConcurrent(items, f, { concurrency })` | boundaries, forms, imports; error is `NonEmptyArray<E>` |
| Never fail, split outcomes | `R.partition(results)` | run `validateConcurrent`, then inspect | batch jobs that must finish |

```ts
import { Async, R, err, ok, type AsyncResult, type NonEmptyArray, type Result } from "two-track";

type LineError = { readonly _tag: "BadLine"; readonly index: number };
const parseLine = (raw: string, index: number): Result<LineError, number> => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? ok(n) : err({ _tag: "BadLine", index });
};

export const firstBad = (raws: ReadonlyArray<string>): Result<LineError, number[]> => R.traverse(raws, parseLine);
export const allBad = (raws: ReadonlyArray<string>): Result<NonEmptyArray<LineError>, number[]> => R.validateAll(raws, parseLine);
export const split = (raws: ReadonlyArray<string>): { readonly oks: number[]; readonly errs: LineError[] } =>
  R.partition(raws.map(parseLine));

type Fetched = { readonly id: string; readonly body: string };
type FetchError = { readonly _tag: "FetchFailed"; readonly id: string };
declare const fetchOne: (id: string, signal: AbortSignal) => AsyncResult<FetchError, Fetched>;

// mapConcurrent fails fast and aborts in-flight work; validateConcurrent runs everything and reports all errors.
export const fetchAllFailFast = (ids: ReadonlyArray<string>, signal: AbortSignal): AsyncResult<FetchError | Async.Aborted, Fetched[]> =>
  Async.mapConcurrent(ids, (id, _index, s) => fetchOne(id, s), { concurrency: 8, signal });
export const fetchAllReport = (ids: ReadonlyArray<string>): AsyncResult<NonEmptyArray<FetchError>, Fetched[]> =>
  Async.validateConcurrent(ids, (id, _index, s) => fetchOne(id, s), { concurrency: 8 });
```

Rule of thumb: **accumulate at input boundaries and in batch processing; fail fast inside sequential business workflows.** `concurrency` is mandatory — unbounded fan-out is the fastest way to take down a dependency.

## Interop edges — the only `try`, the only `.catch`

Third-party code throws and rejects. It is wrapped **exactly once, in `infra/`**, by one of three functions, each converting to a tagged error. Application code never writes `try`, `catch`, or `.catch(` itself (the self-review grep enforces this).

```ts
// infra/ — the ONLY place try/catch and rejection appear, always converted to a tagged error.
import { Async, R, tagged, type AsyncResult, type Result } from "two-track";

export const BadJson = tagged("BadJson")<{ cause: unknown }>();
export const NetworkFailed = tagged("NetworkFailed")<{ url: string; cause: unknown; retriable: boolean }>();
export const UserNotFound = tagged("UserNotFound")<{ userId: string }>();
export type BadJson = ReturnType<typeof BadJson>;
export type NetworkFailed = ReturnType<typeof NetworkFailed>;
export type UserNotFound = ReturnType<typeof UserNotFound>;

// Interop edge 1: a synchronous throwing API.
export const parseJson = (text: string): Result<BadJson, unknown> =>
  R.fromThrowable(() => JSON.parse(text) as unknown, (cause) => BadJson({ cause }));

// Interop edge 2: a promise-returning call that must honour cancellation. Pass the signal through.
// (Async.fromPromise(promise, onReject) is the same for a promise you already hold.)
export const getText = (url: string, signal: AbortSignal): AsyncResult<NetworkFailed, string> =>
  Async.tryPromise(
    (s) => fetch(url, { signal: s }).then((res) => res.text()),
    (cause) => NetworkFailed({ url, cause, retriable: isAbortOrNetwork(cause) }),
    signal,
  );
const isAbortOrNetwork = (cause: unknown): boolean => cause instanceof Error && cause.name !== "AbortError";

// The port translates driver errors into DOMAIN errors. A driver's error type never reaches a workflow.
type Row = { readonly id: string; readonly email: string };
type Driver = { readonly query: (sql: string, params: ReadonlyArray<string>) => Promise<ReadonlyArray<Row>> };
export const DbUnavailable = tagged("DbUnavailable")<{ cause: unknown }>();
export type DbUnavailable = ReturnType<typeof DbUnavailable>;

export const findUser = (db: Driver) => async (userId: string): AsyncResult<UserNotFound | DbUnavailable, Row> => {
  const rows = await Async.fromPromise(db.query("select id, email from users where id = $1", [userId]), (cause) => DbUnavailable({ cause }));
  if (!rows.ok) return rows;
  const row = rows.value[0];
  return row === undefined ? { ok: false, error: UserNotFound({ userId }) } : { ok: true, value: row };
};
```

`Async.tryPromise` receives an `AbortSignal` — pass it into `fetch`/drivers so timeouts and first-failure cancellation actually stop work. Keep the raw `cause` as an `unknown` field for logs; decide `retriable` at the edge where you know the driver.

## Expected error vs defect

| | Expected error (error track) | Defect |
|---|---|---|
| What | An anticipated outcome a caller might handle | A bug or broken invariant; unrecoverable |
| Examples | `UserNotFound`, `PaymentDeclined`, `RateLimited`, a decode failure | an impossible union member reached, config missing *after* startup decoding |
| In the signature? | Yes, as a tag in `E` | No — `assertNever` throws; a rejected promise crashes the request/process |
| Handling | `match` at the edge | Top-level logger only; fix the bug |

```ts
import { assertNever, type Tagged } from "two-track";

type Shipment = Tagged<"Pending"> | Tagged<"InTransit", { carrier: string }> | Tagged<"Delivered", { at: number }>;

// A defect is a state the TYPES prove impossible. assertNever documents that proof; reaching it at
// runtime means a boundary let a lying value through. It is the only sanctioned `throw`.
export const label = (s: Shipment): string => {
  switch (s._tag) {
    case "Pending": return "pending";
    case "InTransit": return `with ${s.carrier}`;
    case "Delivered": return `delivered ${s.at}`;
    default: return assertNever(s, "Shipment");
  }
};
```

Never use `assertNever` (or a deliberate rejection) to avoid designing an error type — only to assert a locally proven invariant.

## Where to handle

| Layer | Does | Does not |
|---|---|---|
| `domain/` | returns `Result` with precise tags | handle, log, retry |
| `workflows/` | composes; widens `E`; may `R.orElse` with a *correct* fallback; retries transient failures by policy | know HTTP statuses, exit codes, or log formats |
| `infra/` (ports) | translates driver errors to domain tags; wraps throw/reject once | decide business meaning |
| edge (`http/`, `cli/`, consumer) | `match` exhaustively to status / exit code / dead-letter; logs | contain business logic |

```ts
import { Async, Cap, R, match, type AsyncResult, type Result } from "two-track";
import { InsufficientStock, OrderNotFound, type ChargeFailed as ChargeFailedT } from "./domain-errors.ts";

type CheckoutError = ReturnType<typeof OrderNotFound> | ReturnType<typeof InsufficientStock> | ChargeFailedT;
type Response = { readonly status: number; readonly body: unknown };

// Handle at the EDGE, exhaustively. Adding a CheckoutError variant breaks this until handled.
export const toResponse = (r: Result<CheckoutError, { readonly id: string }>): Response =>
  R.match<CheckoutError, { readonly id: string }, Response>(
    r,
    (order) => ({ status: 201, body: order }),
    (e) =>
      match(e, {
        OrderNotFound: ({ orderId }) => ({ status: 404, body: { orderId } }),
        InsufficientStock: (s) => ({ status: 409, body: s }),
        ChargeFailed: ({ reason, retriable }) =>
          match(reason, {
            CardExpired: () => ({ status: 402, body: { error: "card expired" } }),
            InsufficientFunds: ({ shortBy }) => ({ status: 402, body: { error: "insufficient funds", shortBy } }),
            FraudSuspected: () => ({ status: retriable ? 503 : 403, body: { error: "declined" } }),
          }),
      }),
  );

// Retry belongs on the error track: policy, not loops. Only retry what is transient.
type Gateway = { readonly charge: (cents: number, signal: AbortSignal) => AsyncResult<ChargeFailedT, void> };
type Deps = { readonly gateway: Gateway; readonly sleeper: Cap.Sleeper; readonly random: Cap.Random };

export const chargeWithRetry = (deps: Deps, cents: number, parent: AbortSignal): AsyncResult<ChargeFailedT | Async.Aborted, void> =>
  Async.retry((_attempt, signal) => deps.gateway.charge(cents, signal), {
    attempts: 5,
    delay: Async.backoff({ baseMs: 100, factor: 2, maxMs: 2_000, random: deps.random.next }),
    retriable: (e) => e.retriable,
    sleeper: deps.sleeper,
    signal: parent,
  });
```

Retry rules: `attempts` counts the first try; `delay` is exponential with full jitter from an **injected** `Random`; the `retriable` predicate reads a field on the error, never a message string; `sleeper` is injected so tests are instant; the parent `AbortSignal` stops retrying on shutdown — no attempt starts after an abort, including during the backoff wait, and the outcome is `err(Aborted)`, which is why the error union above names `Async.Aborted` (it only appears when a `signal` is passed). Wrap the whole thing in `Async.withTimeout` when there is a deadline (`references/concurrency.md`).

## Inference limit: annotate callbacks that can fail several ways

TypeScript infers one `E` for a callback from the *first* `Err<…>` it sees, not the union of every branch. A `withTransaction` body or a `mapConcurrent` callback whose branches return `err(RepoError)` in one place and `err(InsufficientStock)` in another therefore fails to type-check with a confusing message about `Err<unknown>` or "no overload matches". The fix is to state the union once, on the callback:

```ts
import { Async, err, ok, tagged, type AsyncResult } from "two-track";

const RepoError = tagged("RepoError")<{ op: string }>();
const InsufficientStock = tagged("InsufficientStock")<{ sku: string }>();
type ReserveError = ReturnType<typeof RepoError> | ReturnType<typeof InsufficientStock>;
declare const reserve: (sku: string, signal: AbortSignal) => AsyncResult<ReturnType<typeof RepoError>, { ok: boolean }>;

export const reserveAll = (skus: ReadonlyArray<string>, signal: AbortSignal): AsyncResult<ReserveError | Async.Aborted, void[]> =>
  Async.mapConcurrent(
    skus,
    // The annotation is the fix: without it TypeScript picks one branch's error and rejects the other.
    async (sku, _i, s): AsyncResult<ReserveError, void> => {
      const r = await reserve(sku, s);
      if (!r.ok) return r;
      return r.value.ok ? ok(undefined) : err(InsufficientStock({ sku }));
    },
    { concurrency: 4, signal },
  );
```

Name the union (`ReserveError`) next to the errors and reuse it; the edge's `match` then has one type to be exhaustive over. This was found building the proof repo's checkout.

## Checklist

- [ ] Every `Async.retry` names its `retriable` predicate (required); nothing retries validation or `NotFound`
- [ ] A `retry` given a `signal` handles `Aborted` at the edge (the union is `E | Aborted` only then); cancellation is never inferred from "the last error"

- [ ] Every error is a `tagged("WhatHappened")` constructor with structured fields and an exported type derived from it
- [ ] Every public `Result`/`AsyncResult` signature has `E` as a union of named tags — no `Error`, `unknown`, `string`
- [ ] One failure with several causes uses a nested tagged `reason`, not many sibling tags
- [ ] Hot paths use early returns; combinators only outside per-element loops
- [ ] Accumulate at boundaries (`validateAll`/`validateConcurrent`), fail fast in workflows (`traverse`/`mapConcurrent`); every fan-out has `concurrency`
- [ ] `try`, `catch`, `.catch(` appear only inside `R.fromThrowable`/`Async.fromPromise`/`Async.tryPromise` in `infra/`; the `AbortSignal` is threaded into drivers
- [ ] Driver errors are translated to domain tags at the port; no driver type in a workflow signature
- [ ] Errors are handled at the edge with exhaustive `match`; `R.orElse` fallbacks are justified in a comment
- [ ] `assertNever` only on proven-impossible states; nothing on the railway rejects
- [ ] Retries: transient-only predicate, `Async.backoff` with injected `Random`, injected `Sleeper`, parent signal
