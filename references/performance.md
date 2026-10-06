# Performance — Measured, Not Hoped

The railway pattern is free; what costs is the encoding you pick and the allocations you add per element. This file states the numbers the design rests on, the rules that follow from them, how to find the paths where they matter, and when to stop optimizing JavaScript and reach for Rust. Every number comes from a script you can re-run (`two-track/bench/encodings.ts`, `bench/cross/` (a workspace with pinned Zod/Valibot/ArkType/Ramda/Effect), `docs/references/benchmarks.md`). Verified against two-track 0.1.0 (October 2026).

## What the benchmarks say

Workload: a three-step railway (parse quantity → price → discount) over 1,000,000 items, 10% failures, best of 7, Node 24.15 / Bun 1.3.14. CPU-bound by design — in an I/O-bound service none of the JavaScript rows is visible next to a database round trip.

**Encodings of the same railway**

| Encoding | Node 24 | Bun 1.3 |
|---|---|---|
| two plain shapes, boolean `ok`, early return (**the library's baseline**) | 12 ms | 11 ms |
| two-track `R.andThen` combinators (one closure per step) | 24 ms | 19 ms |
| Go tuple `[error, value]` | 18 ms | 13 ms |
| one monomorphic shape with both fields | 22 ms | 14 ms |
| `_tag: "Ok" \| "Err"` string discriminant | 24 ms | 15 ms |
| class with fluent `.andThen()` | 35 ms | 24 ms |
| `throw` / `try` / `catch` | 297–341 ms | 57–79 ms |
| `Object.freeze` on every result | 116–123 ms | 194–213 ms |
| generator do-notation (`safeTry`, `Effect.gen` style) | 969 ms | 464–488 ms |

**Other approaches**

| Approach | Node 24 | Bun 1.3 |
|---|---|---|
| Ramda `pipeWith(chain)` over a Fantasy Land Result | 319 ms | 244 ms |
| Ramda idiomatic point-free | 620 ms | 553 ms |
| Effect 4 `Effect.gen` + `runSync` per item | 2392 ms | 1410 ms |
| Effect 4 `Effect.forEach`, one `runSync` | 1919 ms | 1269 ms |
| Rust `Result` + `?` → WASM, batched, integer args | 4 ms | 3 ms |
| Rust → WASM, one call per item, integer args | 8 ms | 4 ms |
| native Rust binary | 1.5 ms | — |
| `JSON.stringify` + `JSON.parse` of the same 1M objects | 439 ms | — |

Read it as: the baseline is ~12 ns per three-step pipeline; combinators are ~2x; three encodings (generators, freeze, exceptions) are catastrophic; libraries with a runtime or a currying layer are 20–100x; and the WASM boundary for real (object/string) data costs 40x the whole JavaScript railway. The Ramda/Effect rows are reproducible with `pnpm bench:cross` in the library repo (workspace `bench/cross`, pinned versions).

**Decoders versus the field** (`pnpm bench:cross`; one schema in all four libraries — patterns, integer range, array, nested object, optional field; non-throwing APIs; 200k objects; best of 7; all four agree on validity)

| Library | Node 24, valid | Node 24, 10% invalid | Bun 1.3, valid | ns per valid object (Node / Bun) |
|---|---|---|---|---|
| two-track 0.1.0, interpreter | 140 ms | 140 ms | 67 ms | 699 / 335 |
| two-track 0.1.0, `D.compile` | **60 ms** | **62 ms** | 35 ms | **299 / 173** |
| zod 4.6.5 | 176 ms | 215 ms | 131 ms | 881 / 657 |
| valibot 1.5.0 | 209 ms | 215 ms | 133 ms | 1045 / 665 |
| arktype 2.2.7 | **43 ms** | 267 ms | **32 ms** | **213 / 160** |

Honest reading: the interpreter is 20–35% faster than Zod and Valibot and the fastest interpreter when a share of the input is invalid. ArkType's JIT-compiled validator leads on valid input because literal-key code is the only thing below the ~94 ns floor of a generic keyed loop. `D.compile` generates that code and lands within 1.4x of ArkType on Node (8% on Bun), 4x ahead on partly invalid input, at parity on JSON text. Consequences for your design:

1. At under a microsecond per object, decoding is never the bottleneck of an I/O-bound service; `JSON.parse` of the same object costs more. Do not reach for `compile` by reflex.
2. On a CPU-bound path that decodes many **valid** objects (an import job, a stream processor, a cache warm), wrap the boundary decoder once: `const Fast = D.compile(Order)` at module level, next to the decoder. Semantics are identical by construction and property-tested, so nothing else changes.
3. `compile` uses `new Function`. Under a CSP without `unsafe-eval`, on Cloudflare Workers, and in some extensions it is a no-op that returns the interpreter, so calling it is always safe; just do not *count* on the speed-up in those runtimes. Edge code should measure.
4. It compiles the structural subset (struct, array, primitives + refinements, optional, nullable, option, literal); `record`, `taggedUnion`, `oneOf`, `map`, `andThen`, `json`, `lazy` are called through the interpreter from the generated code, so a schema dominated by those gains less.
5. Regex patterns remain the single largest cost on the bench schema (~160 ns of raw `regex.test` for three patterns); keep hot wire shapes flat and keep cosmetic normalization out of the per-object path.

**Decoder and async CPU overhead in isolation** (`pnpm bench:hot`, Node 24): a 4-field struct decodes in ~110 ns; an array of structs ~100 ns per element; error accumulation on an array of invalid items ~35 ns per issue; `mapConcurrent` and `validateConcurrent` add ~120 ns per item with immediately-resolved callbacks; a semaphore `run` with an immediate callback ~650 ns. None of these is visible next to a network call; all of them matter inside a tight loop over in-memory data.

**Lane overhead per trigger** (`pnpm bench:lanes`, Node 24, ratio against a direct call in the same run): `exhaustLane` 0.7x (rejections are a shared `Busy`), `queueLane` 2.7x (~750 ns), `throttle` 3.1x, `semaphore` 7x (~2 µs; it was 376x before its waiter queue was made linear — `Array.shift()` is O(n) on large V8 arrays, a pattern worth grepping your own `src/lib/` for), `debounce` 27x and `switchLane` 36x (~8–10 µs). Lanes belong on user-rate triggers; bounded per-row work uses `mapConcurrent` or a semaphore.

**Consumer bundle sizes** (`pnpm bench:bundle`, minified bytes, esbuild root-namespace import → subpath import): Result `ok`/`err`/`andThen` 1,551 → 117; struct decoder 4,279 → 1,124; primitive decoder 4,234 → 304; async interop 3,102 → 170; concurrent map 3,096 → 642; switch lane 2,744 → 731. Rolldown prunes namespaces itself (114 / 1,119 / 301 / 176 / 653 / 769). Everything the library exports is ~15 kB minified, ~5.4 kB gzip. Rule: browser and edge code imports from subpaths (`references/scaffold.md` §1b).

## The rules that follow

| Rule | Why | Where it applies |
|---|---|---|
| Early returns on per-element paths | baseline; a closure per step is the 2x | anything called in a loop over many items |
| Combinators (`R.andThen`, `R.map`) elsewhere | 2x is invisible next to I/O; reads better | workflow level, once per request |
| No generators, ever | 40–80x | everywhere (banned by the review grep) |
| No `Object.freeze` in `src/` | 10–20x; `readonly` types are free | everywhere (test fixtures excepted) |
| No `throw` for control flow | 5–30x and invisible in types | everywhere |
| No spread/rest, no `.map().filter()` chains, no closures per element | each is an allocation per item | hot paths only |
| Pre-size output arrays; `R.traverse` over `R.all(items.map(f))` | one pass, no intermediate array | hot paths |
| Singleton error objects for unit-like failures | zero allocation on the failure path | hot paths with frequent expected failures |
| `Async.mapConcurrent` with `concurrency` sized to the downstream | protects the dependency; unbounded fan-out is the #1 outage cause | every fan-out |
| Keep JSON round trips out of the process | 439 ms per million objects dwarfs everything above | boundaries: parse once, never re-serialize internally |

```ts
// Hot path vs. warm path: same railway, two sanctioned styles.
import { R, err, ok, tagged, type Result } from "two-track";

type Line = { readonly qty: number; readonly priceCents: number };
const BadQty = tagged("BadQty")<{ qty: number }>();
type BadQty = ReturnType<typeof BadQty>;

// Per-element (called a million times): early returns, no closures, no spread, no allocation beyond the Result.
export const lineTotalHot = (line: Line): Result<BadQty, number> => {
  if (!(line.qty > 0)) return err(BadQty({ qty: line.qty }));
  const t = line.qty * line.priceCents;
  return ok(t > 50_000 ? t - 500 : t);
};

// Once-per-request (workflow level): combinators read better and the ~2x is invisible next to I/O.
const parseQty = (line: Line): Result<BadQty, Line> => (line.qty > 0 ? ok(line) : err(BadQty({ qty: line.qty })));
export const lineTotalWarm = (line: Line): Result<BadQty, number> =>
  R.map(R.andThen(parseQty(line), (l) => ok(l.qty * l.priceCents)), (t) => (t > 50_000 ? t - 500 : t));

// Collections: traverse (one pass, pre-sized output) rather than all(items.map(f)) (two passes, intermediate array).
export const orderTotal = (lines: ReadonlyArray<Line>): Result<BadQty, number> =>
  R.map(R.traverse(lines, lineTotalHot), (totals) => {
    let sum = 0; // contained local mutation inside a pure function is idiomatic
    for (let i = 0; i < totals.length; i++) sum += totals[i] as number;
    return sum;
  });

// Unit-like failures on hot paths: a singleton error object allocates nothing on the failure path.
const EMPTY_CART = err({ _tag: "EmptyCart" } as const);
export const requireNonEmpty = (lines: ReadonlyArray<Line>): Result<{ readonly _tag: "EmptyCart" }, ReadonlyArray<Line>> =>
  lines.length === 0 ? EMPTY_CART : ok(lines);
```

## Finding the hot paths

Do not guess. Two tools, both free:

```bash
# 1. CPU profile a representative run; open the .cpuprofile in Chrome DevTools → Performance → Load.
node --cpu-prof --cpu-prof-dir=./profiles dist/main.js            # or a load script
# 2. Wall-time microbenchmarks for the functions the profile names, kept in bench/ and run in CI as report-only.
node bench/order-total.ts --check
```

An app-local benchmark follows the library's own pattern: best-of-N wall time with `performance.now()`, a fixed workload with a verifiable answer (fail the run if the count is wrong), and a **ratio** assertion against an in-file baseline rather than an absolute millisecond budget — absolute numbers vary 2x between a laptop and a CI runner; ratios are stable.

```ts
// bench/order-total.ts — an app-local benchmark in the style of two-track/bench/encodings.ts.
// Run: node bench/order-total.ts [--check]. Assert RATIOS, never absolute milliseconds (CI machines differ).
import { lineTotalHot, lineTotalWarm } from "../src/domain/pricing.ts";

const N = 1_000_000;
const RATIO_LIMIT = 4;
const lines = Array.from({ length: N }, (_, i) => ({ qty: i % 10 === 0 ? -1 : (i % 7) + 1, priceCents: 100 + (i % 50) }));

const bench = (name: string, fn: (l: (typeof lines)[number]) => { readonly ok: boolean }, reps = 7): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < reps; r++) {
    let failures = 0;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) if (!fn(lines[i] as (typeof lines)[number]).ok) failures++;
    best = Math.min(best, performance.now() - t0);
    if (failures !== N / 10) process.exit(2);
  }
  console.log(`${name.padEnd(32)} ${best.toFixed(1).padStart(8)} ms`);
  return best;
};

const hot = bench("early returns (baseline)", lineTotalHot);
const warm = bench("R.andThen combinators", lineTotalWarm);
const ratio = warm / hot;
console.log(`ratio ${ratio.toFixed(2)}x (limit ${RATIO_LIMIT}x)`);
if (process.argv.includes("--check") && ratio > RATIO_LIMIT) process.exit(1);
```

Rules for a `bench/` folder: plain `.ts` run by Node directly (no build step), one file per hot path, the workload shape mirrors production (realistic failure rate, realistic sizes), and the result table is pasted into the PR when a number moved.

## Sizing concurrency

Concurrency is a property of the downstream, not of the item count: a Postgres pool of 10 means at most ~8 in-flight queries from any one request path; a third-party API with a 100 req/s limit means `concurrency` × (1 / latency) ≤ 100. Start low, measure the downstream's p99 under the fan-out, raise until it bends. Never `Promise.all(items.map(...))`: it is `concurrency: Infinity`.

```ts
// Sizing a fan-out: concurrency is a property of the DOWNSTREAM, not of the item count.
import { Async, type AsyncResult } from "two-track";

type Deps = { readonly fetchPrice: (sku: string, signal: AbortSignal) => AsyncResult<{ readonly _tag: "Upstream" }, number> };

// Pool size 10 on the database → at most ~8 concurrent queries from one request path, leaving headroom.
export const priceAll = (deps: Deps, skus: ReadonlyArray<string>): AsyncResult<{ readonly _tag: "Upstream" }, number[]> =>
  Async.mapConcurrent(skus, (sku, _i, signal) => deps.fetchPrice(sku, signal), { concurrency: 8 });
```

## Node vs Bun

Both engines agree on the ranking; they disagree on the magnitude of the bad encodings (Bun's JavaScriptCore makes `throw` 5x cheaper and generators 2x cheaper than V8, and makes `Object.freeze` 2x more expensive). Write for the ranking, not the engine: code that is fast under the rules above is fast on both. Benchmark on the engine you deploy.

## When JavaScript is the wrong tool

| Situation | Verdict |
|---|---|
| CPU-heavy pure kernel (pricing engine, parser, simulation, compression) over numeric/binary data, called in batches | **Rust → WASM** is 3x faster than the JS baseline and shares the core with a native server. Keep the kernel pure; pass typed arrays; serialize the error enum as a tagged union (`serde` + `ts-rs`/`tsify`) and `match` it in TypeScript |
| The same kernel, but called per item with objects/strings | **Stay in JavaScript.** Marshaling costs 40x the railway; `wasm-bindgen` turns a Rust `Err` into a thrown JS exception, so the typed track dies at the boundary |
| A whole service that must be fast | **Write it in Rust** with `rust-fp-skill`. Native was 3x faster than WASM here and there is no two-toolchain hybrid |
| Everything else (I/O-bound APIs, CLIs, UIs, workers) | **two-track.** The railway is ~12 ns; your database is ~1 ms |

## Symptom → cause → fix


| Symptom | Likely cause | Fix |
|---|---|---|
| p99 latency spikes under load | unbounded fan-out, or no timeouts, so slow dependencies pile up | `Async.mapConcurrent` with explicit `concurrency`; `Async.withTimeout` on every external call |
| High CPU with low throughput | a per-element path allocating closures, spreading, or re-serializing JSON | profile; rewrite the per-element function with early returns; parse once at the boundary |
| GC pauses | `Object.freeze`, intermediate arrays from `.map().filter()`, or `R.all(items.map(f))` | `readonly` types; a single `for` loop or `R.traverse` |
| Exceptions dominating the profile | `throw` used for expected outcomes (validation, not-found) | return `err(Tagged)`; keep `throw` for `assertNever` only |
| Generator frames in the profile | a do-notation helper crept in | early returns / `await` (decision 0002) |
| "Fast locally, slow in CI" | absolute-ms benchmark assertions | assert ratios against an in-file baseline |
| WASM slower than JS | per-call marshaling of objects/strings | batch into typed arrays, or stay in JS |
| A queue/semaphore gets slower as it fills | `Array.shift()` or `indexOf`+`splice` on a large array (O(n) per op on V8) | head-index FIFO with tombstones, compact periodically; measure with a 200k-item drain test |

## Checklist

- [ ] Hot paths are identified by a profile, not a hunch, and each has a `bench/` script with a ratio assertion
- [ ] Per-element functions use early returns; no closures, spread, `.map().filter()` chains, or `Object.freeze` per item
- [ ] Zero generators anywhere in `src/` (grep `function\*|yield`)
- [ ] Collections use `R.traverse` / pre-sized loops rather than `R.all(items.map(f))` on hot paths
- [ ] Every fan-out states `concurrency`, sized to the downstream and documented in a comment
- [ ] JSON is parsed once at the boundary; nothing re-serializes internally
- [ ] Benchmarks assert ratios, run on the deploy engine, and the table is in the PR when a number moved
- [ ] CPU-heavy kernels over binary data were evaluated for Rust/WASM; everything else stayed in JavaScript on purpose
