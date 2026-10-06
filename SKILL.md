---
name: two-track-fp-skill
description: Build production-grade TypeScript applications with zero-runtime-dependency functional programming on the two-track library (Result/Option/decoders/exhaustive match/async railway). Use whenever creating or modifying a TypeScript app, service, CLI, library, browser or edge-worker project that must stay fast and dependency-free, when the user asks for "vanilla", "lightweight", "no-runtime", or "neverthrow-style" FP, or when the project already imports two-track. Do NOT use when the project uses Effect (use effect-fp-skill). Enforces railway-oriented error handling, parse-don't-validate boundaries, illegal-states-unrepresentable domain modeling, capability-record dependency injection, property-based testing, and a measured performance discipline.
---

# Two-Track Functional TypeScript — Railway-Oriented, Zero Runtime

You build every TypeScript application as a **synchronous pure core wrapped in an async capability shell**, with every failure travelling on a typed error track, using the [`two-track`](https://github.com/mikezupper/two-track) library and nothing else at runtime. The design philosophy is Scott Wlaschin's F# work (railway-oriented programming, "Designing with Types", "Parse, don't validate", functional core / imperative shell) and Alexis King's *Parse, Don't Validate*. TypeScript's discriminated unions, control-flow narrowing, `readonly` types, and `never` exhaustiveness are its native realization — and, unlike an effect system, they cost nothing at runtime.

**Target `two-track` 0.1.x on TypeScript 7.0+ and Node 22.18+ / any ES2023 engine** (APIs herein verified against two-track 0.1.0, October 2026). Where this skill differs from `effect-fp-skill`: there is no runtime, so dependencies are explicit capability records, sequencing is early-return or `await`, and the guarantees are *checked* by the compiler plus lint rather than *enforced* by a runtime. Where it differs from `rust-fp-skill`: the compiler checks structure, not nominal identity or purity, so the self-review greps are load-bearing.

## Philosophy

1. **Railway-oriented programming.** Every operation that can fail returns `Result<E, A>` or `AsyncResult<E, A>` with a named tagged `E`. Errors are values on a typed track, never exceptions. `if (!r.ok) return r;` is the switch that shunts to the error track — it is exactly what Rust's `?` desugars to. Compose the happy path; handle failures where you have context to act.
2. **Make illegal states unrepresentable.** Branded primitives from decoders, tagged unions for every "or", `Option` for absence. If the compiler accepts it, it should be valid. No boolean flag pairs, no optional-field soup, no sentinel values.
3. **Parse, don't validate.** Untrusted data is decoded exactly once at each boundary (HTTP, DB row, env, CLI, queue, file, DOM) by a `Decoder` into domain types. Nothing past a decoder re-checks. A domain type constructible from raw input without a decoder is a bug.
4. **Functional core, capability shell.** The domain is synchronous pure functions over `readonly` data and imports only `two-track`. Workflows are `async` functions `(deps, command) => AsyncResult<Error, Outcome>`. Infrastructure implements the capability interfaces. Exactly one composition root builds `deps`.
5. **Totality.** Every function handles every input in its type. No partial functions, no `throw`, no `any`, no `!`, no `default` over a domain union.
6. **Zero-cost abstraction.** Every guarantee lives in the type checker and vanishes at build time. A construct that re-pays for a guarantee at runtime — generators for do-notation (40–80x), `Object.freeze` (10–20x), exceptions as control flow (5–30x), fluent classes on hot paths (2–3x) — is a measured regression, not a style choice.

## Hard rules (non-negotiable)

Every rule has a mechanical check in `references/code-review.md`; several are also ESLint-free greps you add to CI per `references/scaffold.md`.

- **Zero runtime dependencies beyond `two-track`** in `domain/` and `workflows/`. Infrastructure adapters may depend on drivers (`pg`, `undici`, …) and nothing else FP-flavoured: no lodash, no Ramda, no fp-ts, no neverthrow, no Zod. If a helper is missing, write it in `src/lib/` (10–150 lines) and test it.
- **No `throw`, no `try`, no `.catch(`** in application code. The only exceptions are inside `R.fromThrowable`, `Async.fromPromise`, and `Async.tryPromise` calls at the interop edge, each converting to a tagged error. `assertNever` is the one sanctioned defect.
- **No generators for sequencing Results** (`safeTry`/`Effect.gen`-style do-notation; 40–80x measured) and **no `Object.freeze`** anywhere in `src/`. The one permitted `async function*` is a stream *source or adapter* in `infra/` or `lib/` that yields chunks from I/O — never in `domain/`, never per element on a hot path. No classes for data; data are plain objects with a `_tag` (variants, errors) or an `ok`/`some` discriminant (Result/Option).
- **Every error is `tagged("WhatHappened")<{ …fields }>()`** with the data a handler needs (ids, the offending value, `retriable`). Error types in signatures are unions of named tags — never `Error`, `unknown`, `string`.
- **Decode at every boundary with `D.*`; zero `as` casts on external data.** Brands are applied only by `D.brand`. Wire shape ≠ domain shape: separate decoders per boundary.
- **No `null`/`undefined` in domain types** — `Option<A>`. `D.optional`/`D.nullable` exist only in wire decoders.
- **Sum types, not flag soup.** Lifecycle = tagged union with per-state data; branch over it with `match`/`matchBy`/`switch`+`assertNever`. No `default` arm over a domain union.
- **Time, randomness, ids, sleep, I/O are capabilities.** No `Date.now()`, `new Date()`, `Math.random()`, `crypto.randomUUID()`, `setTimeout`, `fetch`, or driver calls in `domain/` or `workflows/`; take `deps: { clock: Cap.Clock; … }`. One composition root.
- **Immutability by type:** `readonly` on every field, `ReadonlyArray`, `as const`. No `let` at module scope; no in-place `push`/`splice`/`sort` on data that escapes a function (contained local mutation inside a pure function is fine).
- **Every fan-out has explicit `{ concurrency: n }`; every external call has `Async.withTimeout`; retries are transient-only with `Async.backoff` and injected `Random`.**
- **Strict TypeScript:** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `erasableSyntaxOnly`. No `any`, no `@ts-ignore`, no non-null `!`.
- **Fakes, not mocks.** Test doubles are plain objects implementing your capability interfaces; `Cap.controlledClock`, `Cap.instantSleeper`, `Cap.manualSleeper`, `Cap.seededRandom`, `Cap.sequentialIds` for the library's capabilities.
- **Run `two-track-check --strict` before declaring any work done.** It is TypeScript's missing `#[must_use]`: an ignored `Result` or an un-awaited `AsyncResult` is an error, not a style note. Every other hard rule above is a rule in it too, with the fix in the message. A suppression comment needs a reason.
- **Prove laws, don't assert examples.** Every custom combinator gets `functorLaws`/`monadLaws` and every decoder gets `decoderRoundTrip` from `two-track/testing` — one line each.

## Decision table

| Situation | Reach for |
|---|---|
| Fallible synchronous operation | `Result<E, A>`; compose with early return (hot path) or `R.andThen`/`R.map` |
| Fallible asynchronous operation | `AsyncResult<E, A>` = `Promise<Result<E, A>>`; `await` + early return, or `Async.andThen` |
| Absence of a value | `Option<A>` (`some`/`none`, `O.*`) |
| Domain error | `const X = tagged("X")<{ … }>()`; `type X = ReturnType<typeof X>` |
| One failure with several causes | one tag with a `reason: ReasonA \| ReasonB` tagged field |
| Boundary data (body, env, row, argv, JSON, DOM) | `D.struct`/`D.array`/`D.taggedUnion`/`D.json` → `Result<DecodeError, Domain>` |
| ID / constrained primitive | `D.brand(D.refine(...), "Name")`; `type Name = Infer<typeof Name>` |
| Money | integer minor units branded `Cents`; never a float |
| State machine / variants | tagged union; `match(value, { … })` exhaustive |
| Custom discriminant (`kind`, `status`) | `matchBy("kind", value, { … })` |
| Dependency (DB, clock, gateway) | interface in `domain/ports.ts`; `deps` record first argument; one composition root |
| Configuration & secrets | decode `process.env` once in `main.ts` with `D.struct`; pass typed `Config` down |
| Collect-or-fail over a collection | `R.traverse(items, f)` / `Async.mapConcurrent(items, f, { concurrency })` |
| Collect *all* failures | `R.validateAll` / `Async.validateConcurrent` (boundaries, batch jobs) |
| Never fail, split outcomes | `R.partition` |
| Retry / backoff | `Async.retry(run, { attempts, delay: Async.backoff({...}), retriable, sleeper })` |
| Deadline | `Async.withTimeout(run, ms, onTimeout, parentSignal)` |
| Cancellation | thread the `AbortSignal` every combinator hands you into `fetch`/drivers |
| Wrapping a throwing/rejecting API | `R.fromThrowable` / `Async.tryPromise` **once**, in `infra/` |
| Multi-service rollback | explicit compensation list on the error path (`references/concurrency.md`) |
| A new trigger arrives while the previous call is in flight (search-as-you-type, double-click, webhook order) | `Lane.switchLane` (newest wins) / `Lane.exhaustLane` (ignore while busy) / `Lane.queueLane` (in order, bounded) — shell only |
| Burst smoothing | `Lane.debounce` (trailing, via `Sleeper`) / `Lane.throttle` (leading, via `Clock`) |
| Bounded concurrency with neither a list nor a trigger | `Lane.semaphore(n).run(f)` |
| Proving a custom combinator or decoder | `two-track/testing`: `functorLaws`, `monadLaws`, `decoderRoundTrip`, `decoderNeverThrows`, `arbDecoded` |
| Checking an app for the foot-guns types cannot see | `npx two-track-check --strict` (ignored Results, layers, platform calls, brand casts, `Promise.all`, `fetch` without signal, `default:` without `assertNever`) |
| Unbounded data | `AsyncIterable` (an `async function*` adapter in `infra/`) + `for await` in the shell; never buffer it all |
| Hot loop over many items | plain early-return functions, no closures/spread/allocation per element (`references/performance.md`) |
| A function that provably cannot fail | return `A`, not `Result<never, A>` |

## Anti-patterns — never do these

```ts
// ❌ throw new Error("not found")           → return err(OrderNotFound({ orderId }))
// ❌ try { … } catch { … }                  → R.fromThrowable / Async.tryPromise at the interop edge only
// ❌ promise.catch(() => null)              → Async.fromPromise(promise, (cause) => NetworkError({ cause }))
// ❌ user: User | null                      → Option<User>
// ❌ isPaid: boolean, isShipped: boolean    → tagged union OrderState
// ❌ JSON.parse(body) as OrderDto           → D.json(OrderDto).decode(body)
// ❌ id as UserId                           → UserId.decode(id)   (brands come from decoders)
// ❌ switch (s._tag) { … default: … }       → match(s, { … }) or default: assertNever(s)
// ❌ function* / yield* for sequencing      → early return / await  (40–80x measured)
// ❌ Object.freeze(order)                   → readonly types        (10–20x measured)
// ❌ class Order { … }                      → type Order = { readonly … }; functions over it
// ❌ Date.now() in a workflow               → deps.clock.now()
// ❌ await Promise.all(items.map(fetchOne)) → Async.mapConcurrent(items, fetchOne, { concurrency: 8 })
// ❌ fetch(url) with no timeout             → Async.withTimeout((signal) => fetchJson(url, signal), 5_000, Timeout)
// ❌ import _ from "lodash" / R from "ramda" → Array methods, two-track, or 20 lines in src/lib/
// ❌ error: string                          → tagged error with structured fields
// ❌ R.map(R.andThen(R.map(x, f), g), h) in a per-element hot loop → early returns
// ❌ reserveStock(line);  (a Result, ignored)   → const r = reserveStock(line); if (!r.ok) return r;   [two-track-check: ignored-result]
// ❌ lines.forEach(reserveStock) / lines.map(reserveStock);  → R.traverse(lines, reserveStock)   [ignored-result-in-callback / ignored-result]
// ❌ lines.forEach(async (l) => { await reserve(l) }) → for-of with await, or Async.mapConcurrent   [floating-async-callback]
// ❌ let current: AbortController | undefined … (hand-rolled "cancel the previous") → Lane.switchLane(run)
// ❌ Async.retry(run, { attempts: 5, delay })   → retriable is required: say which errors are transient
```

## Workflow for building an app

1. **Scaffold** (`references/scaffold.md`): pnpm, TS 7 strict, two-track pinned, `two-track-check` as the lint step, vitest + fast-check, CI; subpath imports (`two-track/result`, `two-track/decode`, …) for browser and edge bundles.
2. **Model the domain first** (`references/domain-types.md`): brands via decoders, tagged unions, `Option`. Write the types before any logic — wrong states should fail to compile.
3. **Define the error taxonomy** (`references/railway.md`): one `tagged` error per failure mode; decide expected-error vs defect; decide accumulate vs fail-fast per step.
4. **Define the boundary decoders** (`references/boundaries.md`): one `D.struct` per place untrusted data enters. Do this before wiring any I/O.
5. **Define the ports** (`references/capabilities-di.md`): interfaces for every dependency a workflow needs; the `Deps` record; fakes alongside.
6. **Write workflows** as `async (deps, command) => AsyncResult<Error, Outcome>` over domain types and ports. Pure decisions in `domain/`; effects only through `deps`. Prefer commands-in/events-out.
7. **Implement infrastructure** (`references/database.md`, `references/concurrency.md`): adapters that translate driver errors into domain errors; wire everything in one `main.ts`.
8. **Test** (`references/testing.md`): pure functions with fast-check properties and the `two-track/testing` law helpers; workflows with fakes and controlled capabilities; error tracks as API surface.
9. **Measure what is hot** (`references/performance.md`): identify per-element paths, keep them allocation-free, benchmark them.
10. **Production-harden** (`references/production.md`): structured logs, timeouts, bounded concurrency, graceful shutdown, health checks.
11. **Self-review** (`references/code-review.md`): run `two-track-check --strict`, then the full review pass, before declaring the work done. Mandatory.

## Reference files — read before working in each area

| File | Read when |
|---|---|
| `references/scaffold.md` | Starting a project: versions, tsconfig, layout, `two-track-check` config, subpath imports, CI |
| `references/railway.md` | Designing errors, composing Result/AsyncResult, accumulation vs fail-fast, interop edges |
| `references/domain-types.md` | Modeling: brands, tagged unions, Option, state transitions, commands/events, money & time |
| `references/boundaries.md` | Any place untrusted data enters: decoders for bodies, rows, env, argv, JSON, DOM |
| `references/pattern-matching.md` | Any branching over variants: `match`, `matchBy`, `switch` + `assertNever` |
| `references/capabilities-di.md` | Ports, the `Deps` record, composition root, config, fakes |
| `references/concurrency.md` | Fan-out, retry, timeout, cancellation, sagas, background work, streams |
| `references/database.md` | Persistence: repositories as ports, row decoders, transactions, migrations |
| `references/testing.md` | Any test writing: vitest, fast-check laws & round-trips, fakes, controlled clock |
| `references/performance.md` | Hot paths, what the benchmarks say, allocation discipline, when WASM/Rust |
| `references/production.md` | Logging, resilience, shutdown, deployment checklist |
| `references/app-shapes.md` | Starting an HTTP API (Hono/Fastify/native), CLI, library, browser/Lit, edge worker |
| `references/code-review.md` | ALWAYS, at the end of every task — the mandatory self-review pass |

## What does NOT map from Effect and Rust — be honest, do not emulate it badly

- **No requirements channel.** There is no `R` in the type. Dependencies are the `deps` parameter; the dependency-direction grep in `code-review.md` is what keeps infrastructure out of the domain.
- **No do-notation.** No `yield*`, no `?`. Early returns and `await` are the sequencing forms. Both are pure; neither is worse FP.
- **No fibers, no interruption.** `AbortSignal` is the cancellation mechanism, and it only works if you thread it into `fetch`/drivers.
- **No nominal types.** A brand can be forged with `as`; the grep for `as Brand<` and `as unknown as` is load-bearing.
- **No schema-derived test generators.** fast-check arbitraries are written next to each decoder with a round-trip property tying them together.
- **No enforced purity.** The compiler cannot see `Date.now()`. The `no-platform-calls` rule in `two-track-check` (and the grep fallback) is load-bearing.
- **No `#[must_use]`.** TypeScript lets you drop a `Result` on the floor. `two-track-check`'s `ignored-result` / `floating-async-result` rules are the substitute; run them.
- **What you get in exchange:** ~12 ns per three-step railway, zero runtime, one dependency of ~900 readable lines, the same build in browsers, workers, edge runtimes, Bun, and Node, and types you can read without a PhD.

## Canonical style

```ts
import { Async, Cap, D, O, R, err, match, ok, tagged, type AsyncResult, type Infer } from "two-track";

// Domain: brands come from decoders; decoders are the smart constructors.
export const Sku = D.brand(D.pattern(/^[A-Z]{3}-\d{3}$/, "expected SKU like ABC-123"), "Sku");
export const Cents = D.brand(D.min(D.integer, 0), "Cents");
export type Sku = Infer<typeof Sku>;
export type Cents = Infer<typeof Cents>;

// Errors: one tag per failure mode, with the data a handler needs.
export const UnknownSku = tagged("UnknownSku")<{ sku: Sku }>();
export const PaymentDeclined = tagged("PaymentDeclined")<{ reason: string; retriable: boolean }>();
export type CheckoutError = ReturnType<typeof UnknownSku> | ReturnType<typeof PaymentDeclined>;

// Ports: what the workflow is allowed to do.
export type Deps = {
  readonly catalog: { readonly price: (sku: Sku, signal: AbortSignal) => AsyncResult<never, O.Option<Cents>> };
  readonly payments: { readonly charge: (amount: Cents, signal: AbortSignal) => AsyncResult<ReturnType<typeof PaymentDeclined>, void> };
  readonly clock: Cap.Clock;
  readonly sleeper: Cap.Sleeper;
};

// Pure core: total, synchronous, trivially property-testable.
export const total = (prices: ReadonlyArray<Cents>): Cents => prices.reduce((a, b) => a + b, 0) as Cents;

// Workflow: the railway. Early returns are the switch; every failure is in the signature.
export const checkout = async (deps: Deps, skus: ReadonlyArray<Sku>): AsyncResult<CheckoutError, Cents> => {
  const priced = await Async.mapConcurrent(
    skus,
    (sku, _i, signal) => Async.andThen(deps.catalog.price(sku, signal), (p) => O.toResult(p, () => UnknownSku({ sku }))),
    { concurrency: 8 },
  );
  if (!priced.ok) return priced;

  const amount = total(priced.value);
  const charged = await Async.retry((_, signal) => deps.payments.charge(amount, signal), {
    attempts: 3,
    delay: Async.backoff({ baseMs: 100 }),
    retriable: (e) => e.retriable,
    sleeper: deps.sleeper,
  });
  if (!charged.ok) return charged;

  return ok(amount);
};

// Edge: the only place errors become statuses; exhaustive by construction.
export const status = (e: CheckoutError): number =>
  match(e, { UnknownSku: () => 422, PaymentDeclined: ({ retriable }) => (retriable ? 503 : 402) });
```
