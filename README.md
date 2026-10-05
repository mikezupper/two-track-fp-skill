# two-track-fp-skill — Zero-Runtime Functional TypeScript

[![Claude Code Skill](https://img.shields.io/badge/Claude_Code-Skill-d97757?logo=anthropic&logoColor=white)](https://code.claude.com/docs/en/skills)
[![two-track](https://img.shields.io/badge/two--track-0.1-black)](https://github.com/mikezupper/two-track)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0_strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Runtime deps](https://img.shields.io/badge/runtime_deps-1_(two--track)-success)](#hard-rules)
[![Paradigm](https://img.shields.io/badge/paradigm-functional-8A2BE2)](https://fsharpforfunandprofit.com/series/thinking-functionally/)
[![ROP](https://img.shields.io/badge/errors-railway--oriented-orange)](https://fsharpforfunandprofit.com/rop/)
[![Types](https://img.shields.io/badge/illegal_states-unrepresentable-success)](https://fsharpforfunandprofit.com/series/designing-with-types/)
[![Testing](https://img.shields.io/badge/testing-property--based-blueviolet)](https://fsharpforfunandprofit.com/series/property-based-testing/)
[![throw](https://img.shields.io/badge/throw-banned-red)](#hard-rules)
[![any](https://img.shields.io/badge/any-banned-red)](#hard-rules)
[![generators](https://img.shields.io/badge/generators-banned_(80x)-red)](#why-zero-runtime)
[![References](https://img.shields.io/badge/references-13_files-informational)](#whats-inside)
[![License](https://img.shields.io/badge/license-CC_BY_4.0-lightgrey)](LICENSE)

A [Claude Code skill](https://code.claude.com/docs/en/skills) that makes an AI coding agent build **every** TypeScript application — backend services, CLIs, libraries, browser and edge-worker code — as a synchronous pure core wrapped in an async capability shell, with every failure travelling on a typed error track, using the [`two-track`](https://github.com/mikezupper/two-track) library and **nothing else at runtime**. Railway-oriented error handling, parse-don't-validate boundaries, illegal-states-unrepresentable domain modeling, capability-record dependency injection, property-based testing, a measured performance discipline, and a production checklist treated as the definition of done.

> **Reference implementation:** [two-track](https://github.com/mikezupper/two-track) — the ~900-line library this skill is built around, with its own benchmarks, decision records, and a worked checkout example. The library's README is the system of record for the measurements and decisions summarized here.

It is the third member of a family. Same philosophy, three realizations:

| Skill | Realization | What you pay |
|---|---|---|
| [rust-fp-skill](https://github.com/mikezupper/rust-fp-skill) | `Result<T, E>` + `?`, enums, ownership, cargo-enforced layering | A compiled language; the compiler *enforces* |
| [effect-fp-skill](https://github.com/mikezupper/effect-fp-skill) | `Effect<A, E, R>`, Schema, Layer, fibers | A fiber runtime (~100x on CPU-bound paths); the runtime *enforces* |
| **two-track-fp-skill** | Plain discriminated unions, functions, `readonly` types, early returns | Nothing at runtime; the compiler *checks*, lint and review *hold the line* |

---

## Table of contents

- [Motivation](#motivation)
- [Why zero runtime](#why-zero-runtime)
- [Principles](#principles)
- [Hard rules](#hard-rules)
- [The Wlaschin → two-track mapping](#the-wlaschin--two-track-mapping)
- [What doesn't map](#what-doesnt-map)
- [What's inside](#whats-inside)
- [Installation](#installation)
- [How the skill works](#how-the-skill-works)
- [How to best leverage it](#how-to-best-leverage-it)
- [Version policy](#version-policy)
- [Sources & credits](#sources--credits)

---

## Motivation

AI agents write plausible TypeScript by default: `async/await` with `try/catch`, `null` checks, `any` when the types get hard, `Promise.all` over whatever list is at hand, `console.log` for observability, and a happy path that works in the demo and falls over in production. Every one of those defaults is a place where correctness leaks out of the type system and into runtime hope.

The two earlier skills in this family fix that through Rust and through Effect. Both work, and both carry a cost that is sometimes the wrong trade: Rust is a different language, and Effect is a runtime whose fiber interpreter costs two orders of magnitude on CPU-bound code and adds a learning curve the team may not want. There is a large class of TypeScript projects — libraries, browser code, edge workers, latency-sensitive services, teams that want "just TypeScript" — where the right answer is the discipline without the runtime.

This skill is that discipline, made enforceable. Hard rules with grep-able checks, decision tables, anti-pattern lists, compile-verified examples, per-area checklists, and a mandatory self-review pass.

## Why zero runtime

The claim that the railway pattern is free was measured, not assumed. Three-step railway, one million items, 10% failures, Node 24 / Bun 1.3 (full tables and method in the [two-track benchmarks](https://github.com/mikezupper/two-track/blob/main/docs/references/benchmarks.md)):

| Approach | Node 24 | Bun 1.3 |
|---|---|---|
| Plain discriminated union, early return (what this skill produces) | 12 ms | 11 ms |
| `two-track` combinators (`R.andThen`) | 24 ms | 19 ms |
| `throw` / `try` / `catch` | 297–341 ms | 57–79 ms |
| `Object.freeze` on every result | 116–123 ms | 194–213 ms |
| Generator do-notation (`safeTry` / `Effect.gen` style) | 969 ms | 464–488 ms |
| Ramda `pipeWith(chain)` | 239 ms | 221 ms |
| Effect 4, `Effect.gen` + `runSync` | 1923 ms | 969 ms |

The Result pattern costs about 12 nanoseconds per pipeline. The libraries and idioms around it are what cost: generators 40–80x, freezing 10–20x, exceptions 5–30x, currying 20x, a fiber runtime 100x. So this skill does not *discourage* those constructs; it **bans** them, and the review pass greps for them.

This is a CPU-bound microbenchmark. In an I/O-bound service none of these rows is visible next to a database round trip — which is exactly why the skill also insists on bounded concurrency, timeouts, and no JSON round trips inside the process, where the real time goes.

## Principles

1. **Railway-oriented programming.** Every fallible operation returns `Result<E, A>` or `AsyncResult<E, A>` with a named tagged `E`. `if (!r.ok) return r;` is the switch — exactly what Rust's `?` desugars to. Compose the happy path; handle failures where there is context to act.
2. **Make illegal states unrepresentable.** Branded primitives from decoders, tagged unions, `Option`. If the compiler accepts it, it should be valid.
3. **Parse, don't validate.** One `Decoder` per boundary; nothing past it re-checks.
4. **Functional core, capability shell.** Synchronous pure domain → async workflows over a `deps` record → infrastructure implementing the ports → one composition root.
5. **Totality.** No partial functions, no `throw`, no `any`, no `default` over a domain union.
6. **Zero-cost abstraction.** Every guarantee lives in the type checker and vanishes at build time.

## Hard rules

Stated in `SKILL.md`, enforced three ways: the strict `tsconfig` in `references/scaffold.md`, [`two-track-check`](https://github.com/mikezupper/two-track/tree/main/tools/check) (a dev-time checker on TypeScript 6's compiler API whose every finding ends with the fix, including the type-aware ignored-`Result` rule), and the greps in `references/code-review.md` as the fallback.

| Banned | Instead |
|---|---|
| `throw`, `try/catch`, `.catch()` | Tagged errors on the track; `R.fromThrowable` / `Async.tryPromise` at the interop edge only |
| Generators (`function*`, `yield`) | Early return; `await` + `Async.andThen` |
| `Object.freeze` | `readonly` types |
| Classes for data | Plain objects with `_tag` / `ok` / `some` discriminants |
| `null` / `undefined` in domain types | `Option<A>` |
| Boolean state flags | Tagged unions with per-state data |
| `as` casts on external data; `as Brand<…>` | `D.*` decoders; brands only via `D.brand` |
| `Date.now()`, `Math.random()`, `randomUUID()`, `setTimeout`, `fetch`, drivers in domain/workflows | Capabilities on `deps` |
| `Promise.all` over a list | `Async.mapConcurrent(items, f, { concurrency })` |
| External calls without a timeout | `Async.withTimeout` + threaded `AbortSignal` |
| lodash, Ramda, fp-ts, neverthrow, Zod, any FP/utility runtime dependency | `two-track`, array methods, or 20 lines in `src/lib/` |
| Mocking libraries | Fakes as plain objects; `Cap.controlledClock` / `instantSleeper` / `seededRandom` / `sequentialIds` |
| `default:` over a domain union | `match` / `matchBy` / `assertNever` |
| `console.log` | A `Logger` port, used at the edge |
| An ignored `Result` / un-awaited `AsyncResult` | `two-track-check --strict` fails the build (`ignored-result`, `floating-async-result`) |
| Hand-rolled "cancel the previous request" | `Lane.switchLane` / `exhaustLane` / `queueLane` |

## The Wlaschin → two-track mapping

| F# for Fun and Profit concept | two-track realization |
|---|---|
| ROP / two-track `Result` | `Result<E, A>` with boolean `ok`; `R.andThen`; early return; `AsyncResult` for the shell |
| Designing with types | `D.brand` on refined decoders; `tagged` unions; `Option`; `readonly` records |
| Parse, don't validate | `D.struct`/`D.taggedUnion`/`D.json` at every boundary; `D.formatIssues` for 400s |
| Validation that reports everything | `D.struct` accumulates; `R.validateAll`; `Async.validateConcurrent` |
| Recipe for a functional app | domain/ → workflows/ → infra/ → `main.ts`; ports as interfaces; `deps` record |
| Commands in, events out | Workflows return a tagged event union; edges dispatch with `match` |
| Property-based testing | fast-check arbitraries beside each decoder; `two-track/testing` law and round-trip helpers |
| Thinking functionally | Data-first functions, `pipe`, immutability by type, totality via `assertNever` |

## What doesn't map

Honesty is a feature of this skill. From `SKILL.md`:

- **No requirements channel.** Dependencies are the `deps` parameter; the dependency-direction grep keeps infrastructure out of the domain.
- **No do-notation.** Early returns and `await` are the sequencing forms. Both are pure; neither is worse FP.
- **No fibers or interruption.** `AbortSignal`, threaded by hand into `fetch` and drivers.
- **No nominal types.** A brand can be forged with `as`; the grep for `as Brand<` is load-bearing.
- **No schema-derived test generators.** Arbitraries are written next to decoders with a round-trip property tying them together.
- **No enforced purity.** The compiler cannot see `Date.now()`; the platform-call grep is load-bearing.
- **What you get in exchange:** ~12 ns per three-step railway, zero runtime, one dependency of ~900 readable lines, the same build in browsers, workers, edge runtimes, Bun, and Node.

This is **checked FP, not enforced FP**. If the compiler must be the gatekeeper, use `rust-fp-skill`. If you want effects in the types within TypeScript and can pay the runtime, use `effect-fp-skill`.

## What's inside

```
two-track-fp-skill/
├── SKILL.md                        # entry point: philosophy, hard rules, decision table,
│                                   # anti-patterns, build workflow, reference index, what doesn't map
└── references/
    ├── scaffold.md                 # pnpm, TS 7 strict tsconfig, layout, the invariants script, vitest, CI
    ├── railway.md                  # tagged errors, expected-vs-defect, composing sync/async,
    │                               # traverse vs validateAll vs partition, interop edges, retry
    ├── domain-types.md             # brands via decoders, tagged unions, Option, state machines,
    │                               # commands/events, money & time, wire vs domain shapes
    ├── boundaries.md               # one decoder per entry point: bodies, params, env, rows, argv, queues, DOM
    ├── pattern-matching.md         # match / matchBy / switch + assertNever; no catch-alls
    ├── capabilities-di.md          # ports, the Deps record, composition root, config & secrets, fakes
    ├── concurrency.md              # mapConcurrent, retry/backoff, timeouts, cancellation, sagas, streams
    ├── database.md                 # repositories as ports, row decoders, transactions, N+1, migrations
    ├── testing.md                  # vitest + fast-check: laws, round-trips, state machines, fakes, no sleeps
    ├── performance.md              # the numbers, hot-path rules, finding hot paths, when WASM/Rust
    ├── production.md               # logging port, statuses at the edge, shutdown, metrics, Docker, checklist
    ├── app-shapes.md               # HTTP API, CLI, library, browser/Lit, edge worker, monorepo
    └── code-review.md              # mandatory self-review: greps, audits, checklist sweep
scripts/
└── verify-snippets.mjs             # compiles every snippet against a two-track checkout; runs the test snippets
```

Every reference ends in a checklist. Every TypeScript example in the references and in `SKILL.md` is extracted and compiled against `two-track` 0.1.0 with the same strict `tsconfig` the scaffold prescribes, and the test examples in `testing.md` are executed, by `scripts/verify-snippets.mjs` (`node scripts/verify-snippets.mjs /path/to/two-track`). Run it after any edit to a reference.

## Installation

A skill is just a folder; installation is a copy.

**Global (all projects):**

```bash
git clone https://github.com/mikezupper/two-track-fp-skill ~/.claude/skills/two-track-fp-skill
rm -rf ~/.claude/skills/two-track-fp-skill/.git
```

**Per-project:**

```bash
git clone https://github.com/mikezupper/two-track-fp-skill <your-project>/.claude/skills/two-track-fp-skill
rm -rf <your-project>/.claude/skills/two-track-fp-skill/.git
```

Then start a new Claude Code session. The skill's `description` frontmatter makes it trigger when the agent creates or modifies a TypeScript project that must stay fast and dependency-free, when you ask for "vanilla", "lightweight", "no-runtime" or "neverthrow-style" FP, or when the project already imports `two-track`. It explicitly yields to `effect-fp-skill` when Effect is present. Invoke it directly with `/two-track-fp-skill`.

## How the skill works

Progressive disclosure, which is why it is a folder and not one big file:

1. `SKILL.md` (~180 lines) loads when the skill triggers: philosophy, hard rules, a decision table ("situation → tool"), the anti-pattern list, an 11-step build workflow, and the honest "what doesn't map" section.
2. Each workflow step points at a **reference file** the agent reads only when working in that area — designing errors loads `railway.md`, touching persistence loads `database.md`, and so on.
3. The final step is **mandatory self-review** (`code-review.md`): `two-track-check --strict` first, then mechanical greps for banned constructs, a dependency-direction audit, error-channel, type-design, runtime, performance and test audits, and a sweep of every checklist touched — before the agent may declare the work done.

## How to best leverage it

**Prompting**

- Just ask for the app — "build a URL-shortener API with Postgres" is enough; the skill supplies the architecture. You don't need to say "use two-track" or "use FP".
- Say **"production-ready"** when you mean it — that pulls the full `production.md` checklist into scope as acceptance criteria.
- Say **"hot path"** or **"this runs per request/per row"** about the parts that are — that pulls `performance.md` and makes the agent write early-return code and add a bench.
- Name the shape when ambiguous ("as a CLI", "as a library", "as a Cloudflare worker") so the right `app-shapes.md` section drives the scaffold.

**Reviewing the output**

- The agent must run the `code-review.md` pass itself; the same greps are a good human review script and most are in the scaffolded `scripts/invariants.ts`.
- Pair with `/code-review` (or ultrareview for big changes) for an independent adversarial pass; this skill biases construction, a reviewer biases destruction.

**Customizing**

- The rules are opinions — edit them. Keep the structure: hard rules + decision tables + anti-patterns + checklists is the format agents follow best.
- Add project-specific conventions as a *project* skill that references this one rather than forking it.
- If you adopt a validation library the team already uses, put a thin adapter in `infra/` that returns `Result<DecodeError, A>`; do not let its error shape leak inward.

**Maintaining**

- The skill pins its knowledge to `two-track` 0.1.x. On each library release, re-run the compile check of every reference snippet against the new version (the method is in the library's `CONTRIBUTING.md`) and update the "Verified against" notes.

## Version policy

- **Target:** `two-track` 0.1.x and `two-track-check` 0.1.x, TypeScript 7.0+ for the app, Node ≥ 22.18 (native type stripping) or any ES2023 engine.
- Every reference snippet was compiled with the strict `tsconfig` from `references/scaffold.md` against two-track 0.1.0 (October 2026).
- The `Result`/`Option` encodings (`ok`/`value`/`error`, `some`/`value`) are part of the library's public contract; code written with this skill narrows on them directly and will not need changes in a minor version.

## Sources & credits

- **Scott Wlaschin — [F# for Fun and Profit](https://fsharpforfunandprofit.com)**: [Railway Oriented Programming](https://fsharpforfunandprofit.com/rop/) · [A Recipe for a Functional App](https://fsharpforfunandprofit.com/series/a-recipe-for-a-functional-app/) · [Designing with Types](https://fsharpforfunandprofit.com/series/designing-with-types/) · [Property-Based Testing](https://fsharpforfunandprofit.com/series/property-based-testing/)
- **Alexis King — [Parse, Don't Validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/)**
- **[two-track](https://github.com/mikezupper/two-track)** — the library, its benchmarks and decision records
- **[Harness engineering](https://openai.com/index/harness-engineering/)** — for the agent-first organization of the library repository and the "fix in the message" lint style
- **[Claude Code skills](https://code.claude.com/docs/en/skills)** — the skill format and progressive-disclosure model

*This skill encodes one person's opinionated synthesis; none of the authors above endorse it.*

## License

Text and markup licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) © 2026 Mike Zupper. The `two-track` library itself is MIT.
