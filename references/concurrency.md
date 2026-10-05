# Concurrency — Bounded Fan-out, Retry, Deadlines, Cancellation, Sagas

There are no fibers here: a workflow is an `async` function, concurrency is `Promise` machinery, and the only cancellation mechanism the platform offers is `AbortSignal`. That is enough if you follow four rules. **Bound everything** (`{ concurrency: n }` on every fan-out). **Thread the signal** (every combinator hands you one; pass it into `fetch` and drivers or cancellation does nothing). **Never fire and forget** (every promise is awaited or owned by a worker loop with a signal). **Retry only what is transient**, with jitter from an injected `Random` and delays from an injected `Sleeper`, so tests are instant and deterministic.

Verified against two-track 0.1.0 (October 2026).

## The interop edge and the three fan-outs

```ts
import { Async, R, ok, err, tagged, type AsyncResult } from "two-track";

export const Network = tagged("Network")<{ url: string; cause: unknown; retriable: boolean }>();
export const BadBody = tagged("BadBody")<{ url: string; status: number }>();
export const Timeout = tagged("Timeout")<{ url: string; ms: number }>();
export type FetchError = ReturnType<typeof Network> | ReturnType<typeof BadBody> | ReturnType<typeof Timeout>;

// infra/http.ts — the interop edge, written once. The signal is threaded into fetch.
export const getJson = (url: string, signal: AbortSignal): AsyncResult<FetchError, unknown> =>
  Async.andThen(
    Async.tryPromise((s) => fetch(url, { signal: s }), (cause) => Network({ url, cause, retriable: true }), signal),
    (res) =>
      res.ok
        ? Async.tryPromise(() => res.json() as Promise<unknown>, () => BadBody({ url, status: res.status }))
        : err(BadBody({ url, status: res.status })),
  );

// Bounded, fail-fast fan-out: the first error aborts in-flight requests and stops launching more.
export const fetchAll = (urls: ReadonlyArray<string>, parent: AbortSignal): AsyncResult<FetchError, unknown[]> =>
  Async.mapConcurrent(urls, (url, _i, signal) => getJson(url, signal), { concurrency: 8, signal: parent });

// Accumulating fan-out for batch jobs: every row runs, every failure is reported.
export const importAll = <A>(rows: ReadonlyArray<A>, importRow: (row: A, signal: AbortSignal) => AsyncResult<string, void>) =>
  Async.validateConcurrent(rows, (row, _i, signal) => importRow(row, signal), { concurrency: 16 });

// Independent work already started: Async.all keeps order and fails on the first error.
export const profilePage = async (
  loadProfile: () => AsyncResult<FetchError, { name: string }>,
  loadOrders: () => AsyncResult<FetchError, number>,
): AsyncResult<FetchError, { name: string; orders: number }> => {
  const both = await Async.all<FetchError, { name: string } | number>([loadProfile(), loadOrders()]);
  return R.map(both, ([profile, orders]) => ({ name: (profile as { name: string }).name, orders: orders as number }));
};
```

| Need | Reach for | Semantics |
|---|---|---|
| Apply a fallible async fn to many items | `Async.mapConcurrent(items, f, { concurrency, signal? })` | bounded; first error wins; aborts in-flight via the signal passed to `f`; results in input order |
| Same, but report every failure | `Async.validateConcurrent(items, f, { concurrency })` | bounded; runs everything; `Err<NonEmptyArray<E>>` or all values |
| A few heterogeneous promises you already started | `Async.all([p1, p2])` | first error wins; use a tuple cast or separate awaits for heterogeneous types |
| Sequential dependency | `await` + early return, or `Async.andThen` | the railway |
| CPU-bound loop over many items | plain synchronous early-return functions (`performance.md`) | no promises at all |

`Async.all` is typed over a homogeneous `E`/`A`; for two differently-typed loads, prefer two `await`s or a small helper. Never `await Promise.all(items.map(f))` — it is unbounded and its rejection semantics leave the railway.

## Retry, backoff, deadlines

```ts
import { Async, type AsyncResult, type Cap } from "two-track";
import { getJson, Timeout, type FetchError } from "./http.ts";

type Deps = { readonly sleeper: Cap.Sleeper; readonly random: Cap.Random };

// Retry only what is transient; jitter comes from an injected Random; delays from an injected Sleeper.
// Because a `signal` is passed, the union gains Async.Aborted: cancelling during a backoff wait is visible in the type.
export const getJsonResilient = (deps: Deps, url: string, parent: AbortSignal): AsyncResult<FetchError | Async.Aborted, unknown> =>
  Async.retry(
    (_attempt, signal) =>
      Async.withTimeout((s) => getJson(url, s), 5_000, () => Timeout({ url, ms: 5_000 }), signal),
    {
      attempts: 4,
      delay: Async.backoff({ baseMs: 100, factor: 2, maxMs: 2_000, random: deps.random.next }),
      retriable: (e) => e._tag === "Timeout" || (e._tag === "Network" && e.retriable),
      sleeper: deps.sleeper,
      signal: parent,
    },
  );

// A request-level deadline that every nested call inherits through the signal.
export const withRequestDeadline = <E, A>(
  ms: number,
  run: (signal: AbortSignal) => AsyncResult<E, A>,
  parent: AbortSignal,
): AsyncResult<E | { readonly _tag: "Deadline"; readonly ms: number }, A> =>
  Async.withTimeout(run, ms, () => ({ _tag: "Deadline" as const, ms }), parent);
```

Rules:
- Put the per-attempt timeout *inside* the retry, and the overall deadline *outside* it (the `parent` signal). Retrying a call with no timeout retries a hang.
- `retriable` is a predicate on a field of your error (`retriable: true`, or a tag), decided by the adapter that knows the driver. Never retry a `BadBody` or a validation failure.
- `Async.backoff` without `random` is deterministic exponential; with `random: deps.random.next` it is full jitter. Production passes `Cap.systemRandom.next`; tests pass `Cap.seededRandom(1).next`.
- `Cap.instantSleeper()` makes retry tests instant and records the delays it was asked for, so the schedule is an assertion, not a wait.

## Sagas — compensation on the error track

Once a step leaves your database there is nothing to roll back. Order steps so the irreversible one is last, give every external call an idempotency key from `Cap.IdGen`, and collect a compensation for each completed step. On the error track run them in reverse; a failing compensation is logged for a reconciler, never thrown.

```ts
import { ok, tagged, type AsyncResult, type Cap } from "two-track";

export const ReserveFailed = tagged("ReserveFailed")<{ sku: string }>();
export const ChargeFailed = tagged("ChargeFailed")<{ reason: string }>();
export const ShipFailed = tagged("ShipFailed")<{ reason: string }>();
export type PlaceError = ReturnType<typeof ReserveFailed> | ReturnType<typeof ChargeFailed> | ReturnType<typeof ShipFailed>;

type Compensation = { readonly name: string; readonly run: (signal: AbortSignal) => AsyncResult<unknown, void> };

type Deps = {
  readonly inventory: {
    readonly reserve: (sku: string, idemKey: string, signal: AbortSignal) => AsyncResult<ReturnType<typeof ReserveFailed>, void>;
    readonly release: (sku: string, idemKey: string, signal: AbortSignal) => AsyncResult<unknown, void>;
  };
  readonly payments: {
    readonly charge: (cents: number, idemKey: string, signal: AbortSignal) => AsyncResult<ReturnType<typeof ChargeFailed>, string>;
    readonly refund: (chargeId: string, signal: AbortSignal) => AsyncResult<unknown, void>;
  };
  readonly shipping: { readonly book: (sku: string, signal: AbortSignal) => AsyncResult<ReturnType<typeof ShipFailed>, string> };
  readonly ids: Cap.IdGen;
  readonly log: (event: string, fields: Readonly<Record<string, unknown>>) => void;
};

const compensate = async (deps: Deps, done: ReadonlyArray<Compensation>, signal: AbortSignal): Promise<void> => {
  for (const c of [...done].reverse()) {
    const r = await c.run(signal);
    if (!r.ok) deps.log("saga.compensation_failed", { step: c.name, error: r.error }); // logged, never thrown
  }
};

export const placeOrder = async (deps: Deps, sku: string, cents: number, signal: AbortSignal): AsyncResult<PlaceError, string> => {
  const done: Compensation[] = [];
  const idemKey = deps.ids.next(); // one key per attempt makes every external call safe to retry

  const reserved = await deps.inventory.reserve(sku, idemKey, signal);
  if (!reserved.ok) return reserved;
  done.push({ name: "release", run: (s) => deps.inventory.release(sku, idemKey, s) });

  const charged = await deps.payments.charge(cents, idemKey, signal);
  if (!charged.ok) {
    await compensate(deps, done, signal);
    return charged;
  }
  done.push({ name: "refund", run: (s) => deps.payments.refund(charged.value, s) });

  const booked = await deps.shipping.book(sku, signal); // the irreversible step goes LAST
  if (!booked.ok) {
    await compensate(deps, done, signal);
    return booked;
  }
  return ok(booked.value);
};
```

An in-memory compensation list handles the error path; it does not handle `kill -9`. Persist "reserved X for order Y" before you need it so a reconciler can finish after the process is gone. Inside one database, use a transaction instead (`database.md`) — most sagas are one transaction in disguise.

## Rate limiting, background work, streams

All three are small enough to own. Timers belong to `Cap.Sleeper`; the domain never calls `setTimeout`.

```ts
import { type AsyncResult, type Cap } from "two-track";

// src/lib/token-bucket.ts
export type Limiter = { readonly acquire: (signal: AbortSignal) => Promise<void> };

export const tokenBucket = (deps: { readonly clock: Cap.Clock; readonly sleeper: Cap.Sleeper }, perSecond: number, burst = perSecond): Limiter => {
  let tokens = burst;
  let last = deps.clock.now();
  const refill = (): void => {
    const now = deps.clock.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSecond);
    last = now;
  };
  return {
    acquire: async (signal) => {
      refill();
      while (tokens < 1 && !signal.aborted) {
        await deps.sleeper.sleep(Math.ceil(((1 - tokens) / perSecond) * 1000), signal);
        refill();
      }
      tokens -= 1;
    },
  };
};

// Background worker: a loop that stops cleanly when the signal fires.
export const runWorker = async <E>(
  poll: (signal: AbortSignal) => AsyncResult<E, number>,
  onError: (e: E) => void,
  sleeper: Cap.Sleeper,
  signal: AbortSignal,
): Promise<void> => {
  while (!signal.aborted) {
    const r = await poll(signal);
    if (!r.ok) onError(r.error);
    const idle = r.ok && r.value === 0;
    if (idle) await sleeper.sleep(500, signal);
  }
};

// Streams: process unbounded data in fixed-size chunks without buffering it all.
export async function* chunks<A>(source: AsyncIterable<A>, size: number): AsyncIterable<ReadonlyArray<A>> {
  let batch: A[] = [];
  for await (const item of source) {
    batch.push(item);
    if (batch.length === size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

export const ingest = async <A, E>(
  source: AsyncIterable<A>,
  writeBatch: (rows: ReadonlyArray<A>, signal: AbortSignal) => AsyncResult<E, void>,
  signal: AbortSignal,
): AsyncResult<E, number> => {
  let written = 0;
  for await (const batch of chunks(source, 500)) {
    if (signal.aborted) break;
    const r = await writeBatch(batch, signal);
    if (!r.ok) return r;
    written += batch.length;
  }
  return { ok: true, value: written };
};
```

`chunks` is an async generator — the one place a generator is right, because it *is* the stream and runs once per 500 rows, not once per railway step. Workers are started from `main.ts` with the shutdown signal and awaited before `disposers` run, so shutdown drains in-flight work.

## Lanes — a new trigger arrived; what happens to the previous call?

`mapConcurrent` is for a finite collection you already hold. UIs, HTTP handlers, webhooks and pollers ask a different question: a trigger arrives while the last operation is still running. Those are the `switchMap` / `exhaustMap` / `concatMap` semantics, shipped as plain functions in the `Lane` namespace (two-track decision 0009). Each lane holds contained state in a closure you create once — in the shell, next to the event handler, never in `domain/` — and each adds its outcome to the error union so the edge must say what it means to the user.

| Trigger pattern | Lane | Rejected calls get |
|---|---|---|
| Search-as-you-type, latest wins | `Lane.switchLane(run)` | `Superseded` (immediately, even if the old run ignores its signal) |
| Save button, ignore while busy | `Lane.exhaustLane(run)` | `Busy` |
| Webhook / command log, strict order with back-pressure | `Lane.queueLane(run, { depth })` | `QueueFull({ depth })` beyond `depth` waiting; `Busy` for calls still waiting when the lane is aborted |
| Burst smoothing, trailing edge | `Lane.debounce(run, ms, { sleeper })` | `Superseded` for every call but the last in the burst |
| Rate cap, leading edge | `Lane.throttle(run, ms, { clock })` | `Busy` inside the window |
| Bounded concurrency, no list and no trigger | `Lane.semaphore(n).run(f)` | `Busy` only if aborted while waiting |

```ts
import { Async, Cap, Lane, R, err, match, ok, tagged, type AsyncResult } from "two-track";

const Network = tagged("Network")<{ cause: unknown }>();
type Network = ReturnType<typeof Network>;
type Hit = { readonly id: string; readonly title: string };

// infra: the only fetch, signal threaded
const searchApi = (q: string, signal: AbortSignal): AsyncResult<Network, ReadonlyArray<Hit>> =>
  Async.tryPromise(
    async (s) => (await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: s })).json() as Promise<ReadonlyArray<Hit>>,
    (cause) => Network({ cause }),
    signal,
  );

// shell: debounce the keystrokes, then let only the newest request win
const debounced = Lane.debounce((signal, q: string) => searchApi(q, signal), 250, { sleeper: Cap.systemSleeper });
export const search = Lane.switchLane((signal, q: string) => debounced(q), { signal: new AbortController().signal });

// the edge decides what each outcome looks like; Superseded is normal, not an error to show
export const render = (r: Awaited<ReturnType<typeof search>>): string =>
  R.match(
    r,
    (hits) => `${hits.length} results`,
    (e) => match(e, { Network: () => "offline — retry", Superseded: () => "" }),
  );

// a save button: second click while saving is ignored, and the UI can say so
const saveApi = (draft: string, signal: AbortSignal): AsyncResult<Network, void> => Async.tryPromise(async () => void draft, (cause) => Network({ cause }), signal);
export const save = Lane.exhaustLane((signal, draft: string) => saveApi(draft, signal));

// ordered ingestion with back-pressure; a full queue is a 429, not a dropped promise
const handle = async (_signal: AbortSignal, event: string): AsyncResult<never, string> => ok(event.toUpperCase());
export const ingest = Lane.queueLane(handle, { depth: 100 });
export const ingestStatus = (r: Awaited<ReturnType<typeof ingest>>): number => (r.ok ? 202 : 429);

// a semaphore when the bound is a resource, not a list
const db = Lane.semaphore(10);
export const load = (id: string): AsyncResult<Lane.Busy | Network, string> => db.run((signal) => (id === "" ? Promise.resolve(err(Network({ cause: "empty id" }))) : Promise.resolve(ok(id))), undefined);
```

Testing lanes needs no real time: `Cap.manualSleeper()` fires debounce timers when the test says so, `Cap.controlledClock()` moves the throttle window, and deferred promises stand in for in-flight work. Assert the tag of the rejected call, that the superseded run observed `signal.aborted`, and that the lane-level `signal` aborts everything.

## What not to do

| Don't | Because | Instead |
|---|---|---|
| `await Promise.all(items.map(f))` | unbounded; a rejection abandons the railway | `Async.mapConcurrent(items, f, { concurrency })` |
| `void doThing()` / un-awaited promise | work you cannot observe, cancel, or drain on shutdown | `runWorker` with a signal, awaited in `main.ts` |
| `setTimeout` in `domain/` or `workflows/` | untestable, uncancellable | `deps.sleeper.sleep(ms, signal)` |
| retry without a per-attempt timeout | retries a hang | `withTimeout` inside `retry` |
| retry everything | duplicates non-idempotent writes, hammers a failing dependency | `retriable` predicate + idempotency keys |
| ignoring the `signal` a combinator passes you | timeouts and first-failure aborts do nothing | pass it to `fetch`, drivers, `sleep` |
| buffering a cursor/stream into an array | memory grows with the table | `for await` over `chunks(source, n)` |
| A hand-rolled `AbortController` + `busy` flag to cancel or ignore the previous call | Subtle to get right; the superseded promise is usually left hanging | `Lane.switchLane` / `Lane.exhaustLane` / `Lane.queueLane` |

## Checklist

- [ ] Every `Async.retry` that takes a `signal` handles `Aborted`; nothing is retried after cancellation (the library guarantees no attempt starts after an abort, including during the backoff wait)
- [ ] Every "what happens to the previous call" situation uses a `Lane`, in the shell, and the edge handles `Superseded`/`Busy`/`QueueFull` explicitly

- [ ] Every fan-out is `Async.mapConcurrent` / `Async.validateConcurrent` with an explicit `concurrency`
- [ ] Every port call and every `fetch` receives the `AbortSignal` it was handed
- [ ] Every external call has `Async.withTimeout`; the request deadline is the parent signal
- [ ] Retries use `Async.retry` with a `retriable` predicate, `Async.backoff` with injected `random`, and `deps.sleeper`
- [ ] External writes carry an idempotency key from `Cap.IdGen`
- [ ] Multi-service workflows order the irreversible step last and compensate in reverse on the error track; compensation failures are logged, not thrown
- [ ] No un-awaited promises; workers take the shutdown signal and are drained before disposers run
- [ ] Unbounded data is consumed with `for await` in chunks, never buffered
- [ ] No `setTimeout`/`setInterval` outside `infra/` and `main.ts`
