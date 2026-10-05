# Self-Review Pass — run before declaring any work done

After implementing, review your own output as a hostile reviewer would. Do this **every time**, before reporting completion. Fix everything found, then re-run the pass. There is no runtime in this stack, so static checks are what stands between "the types say so" and "the code does so". Run the checker first; the greps are the fallback for a repo that cannot run it (and a second opinion when it can). Verified against two-track 0.1.0 (October 2026).

## 0. Run the checker

```bash
npx two-track-check --strict .        # exit 1 on any error OR review finding; every line ends with "— fix: …"
npx two-track-check --json . > two-track-check.json   # for CI annotations
```

Zero findings, or every suppression (`// two-track-check-allow <rule> <reason>`) has a reason you would defend in review. Paste the summary line into your completion report. The rules that only the checker can see, because they need types: `ignored-result` (a `Result` used as a statement — the error vanished), `floating-async-result` (an un-awaited promise), `no-brand-cast` on a branded target type. Review-severity findings (`review-unwrap-or`, `review-decode-unknown`) are not bugs by definition; read each and either confirm it in a comment or change the code.

## 1. Mechanical sweep — run these greps over `src/`

Every hit is either a violation to fix or a documented, justified exception (an `infra/` interop edge, `main.ts`, a test fixture). Zero unexplained hits. Comment lines are filtered with `grep -vE '^\S+:\s*(\*|//)'` so prose that *mentions* a banned word does not count.

```bash
NOCOMMENT="grep -vE ^\S+:\s*(\*|//)"

# --- control flow: errors are values ---
grep -rnE '\bthrow\b' src --include='*.ts' | $NOCOMMENT                        # only assertNever's own body (if you vendored one) — otherwise zero
grep -rnE '\btry\s*\{' src --include='*.ts'                                    # only inside R.fromThrowable / Async.tryPromise wrappers in infra/
grep -rnE '\.catch\(' src --include='*.ts'                                     # zero: Async.fromPromise(promise, onReject)
grep -rnE 'function\s*\*|\byield\b' src --include='*.ts' | grep -v 'src/infra/\|src/lib/'   # zero: generators are 40-80x (decision 0002); the one allowed form is an async function* stream ADAPTER in infra/ or lib/

# --- totality & type honesty ---
grep -rnE ':\s*any\b|\bas any\b|<any>|@ts-(ignore|expect-error|nocheck)' src --include='*.ts'   # zero (tests may use @ts-expect-error to prove exhaustiveness)
grep -rnE '[A-Za-z0-9_)\]]!\.' src --include='*.ts'                            # non-null assertions: zero
grep -rnE 'as Brand<|as unknown as' src --include='*.ts' | grep -v 'src/domain/.*decoders'      # brands come from D.brand; double casts only inside decoders
grep -rnE '\bas [A-Z][A-Za-z]*\b' src/domain src/workflows --include='*.ts' | grep -vE 'as const|decoders\.ts|brand\.ts'  # arithmetic on a brand re-brands through ONE helper next to its decoder
grep -rnE '\b(null|undefined)\b' src/domain --include='*.ts' | grep -vE 'fromNullable|toNullable|D\.(nullable|optional|option)|ok\(undefined\)|: void'   # Option instead

# --- data are plain, immutable, allocation-aware ---
grep -rnE 'Object\.freeze' src --include='*.ts'                                 # zero (decision 0003); tests only
grep -rnE '^\s*(export\s+)?class\s+[A-Z]' src --include='*.ts'                  # zero: tagged objects + functions
grep -rnE '^\s*(export\s+)?let\b' src --include='*.ts'                          # module-scope let: zero
grep -rnE '\.(push|splice|sort|reverse|shift|unshift|pop)\(' src/domain --include='*.ts'   # mutation of escaping data? each hit must be a contained local

# --- capabilities: only the adapter touches the platform ---
grep -rnE 'Date\.now\(|new Date\(\)|Math\.random\(|randomUUID\(|\bsetTimeout\(|\bsetInterval\(' src --include='*.ts' | grep -vE 'src/infra/|src/main\.ts' | $NOCOMMENT
grep -rnE '\bconsole\.' src --include='*.ts' | grep -v 'src/main\.ts'           # Logger port, not console
grep -rnE 'process\.env' src --include='*.ts' | grep -v 'src/main\.ts'          # config decoded once, in the composition root

# --- concurrency & resilience ---
grep -rnE '\bPromise\.all\(' src --include='*.ts'                               # Async.mapConcurrent with explicit concurrency
grep -rnE '\bfetch\([^)]*\)' src --include='*.ts' | grep -v signal              # every fetch takes the signal you were handed
grep -rnE 'mapConcurrent\(' src --include='*.ts' | grep -v concurrency          # heuristic: the options object must be on the same line or the next
grep -rnE '\.andThen\(|\.map\(' src/domain --include='*.ts' | head             # fluent methods on a Result? there are none — this catches a class-based Result sneaking in

# --- exhaustiveness: no catch-all over a domain union ---
grep -rnE -A1 '^\s*default:' src --include='*.ts' | grep -vE 'default:|assertNever|^--$'   # a default arm must be `return assertNever(x)`

# --- dependencies: two-track and nothing FP-flavoured ---
grep -rnE "from [\"'](lodash|ramda|fp-ts|neverthrow|zod|valibot|purify-ts|effect|ts-pattern|remeda)" src --include='*.ts'
```

Reviewer checks the greps cannot make: an `AsyncResult` that is neither `await`ed nor returned (a floating railway — read every `Async.` call site); a `retriable` predicate that reads a message substring instead of a field; a `D.optional` on a domain type rather than a wire type.

## 2. Dependency-direction audit

The onion is a convention here, not a compiler error, so check it mechanically. Add the same greps to `test/architecture.test.ts` so `pnpm test` fails on drift (see `scaffold.md`).

```bash
# domain/ may import ONLY from "two-track" and its own directory
grep -rnE '^import' src/domain --include='*.ts' | grep -vE 'from "(two-track|\./|\.\./domain)'
# workflows/ may import domain and two-track; never infra, drivers, frameworks, node:
grep -rnE '^import' src/workflows --include='*.ts' | grep -vE 'from "(two-track|\./|\.\./domain)'
# drivers and frameworks live ONLY in infra/ and main.ts
grep -rnE "from [\"'](pg|postgres|mysql2|better-sqlite3|undici|hono|fastify|express|ioredis|amqplib|@aws-sdk|node:)" src --include='*.ts' | grep -vE 'src/infra/|src/main\.ts'
# exactly one composition root
grep -rlE 'systemClock|systemIdGen|systemSleeper|systemRandom' src --include='*.ts'      # expect: src/main.ts only
```

- [ ] `domain/` is synchronous: no `async`, no `await`, no `Promise` in its signatures (`grep -rnE '\basync\b|\bawait\b|Promise<' src/domain`)
- [ ] `workflows/` name **ports** (interfaces in `domain/ports.ts`), never concrete adapters
- [ ] Nothing but `main.ts` constructs the production `Deps` record

## 3. Error-channel audit

Read every exported function signature that returns `Result`/`AsyncResult` and check:

- [ ] `E` is a union of **named tags** — never `Error`, `unknown`, `string`, `DecodeError` leaking past the boundary, nor an accidental `never` on a function that can fail
- [ ] Each tag carries actionable data (`{ orderId }`, `{ sku, requested, available }`, `{ retriable }`), not prose; the name says what happened, not who threw
- [ ] Infra errors are translated inside `infra/`: no driver error type is visible in a workflow or port signature
- [ ] One failure mode with several causes is one tag with a tagged `reason`, not five sibling tags
- [ ] Accumulate at boundaries (`D.struct`, `R.validateAll`, `Async.validateConcurrent`), fail fast in workflows (`R.traverse`, `Async.mapConcurrent`); each choice deliberate
- [ ] Every `R.fromThrowable` / `Async.tryPromise` / `Async.fromPromise` converts to a specific tag and lives in `infra/`
- [ ] No `R.unwrapOr(r, default)` that silences an error a caller needed to see
- [ ] `assertNever` only where the types prove the state impossible

## 4. Type-design audit

- [ ] No naked `string`/`number` for ids, money, quantities crossing domain boundaries — brands produced by `D.brand`
- [ ] Money is integer minor units (`Cents`), never a float; dates are epoch ms or branded ISO strings, never `Date` in the domain
- [ ] No boolean flag pairs or optional-field soup encoding states — tagged unions with per-state data
- [ ] Every inspection of a domain union goes through `match`/`matchBy` or `switch` + `assertNever`; zero `default` without it
- [ ] `readonly` on every field, `ReadonlyArray` for every collection; `as const` on literals
- [ ] Wire shape ≠ domain shape where they differ (`UserRow`, `UserResponse`, `User` have separate decoders)
- [ ] Every boundary decodes exactly once; nothing downstream re-checks (`typeof` guards in `domain/` are a smell)

## 5. Runtime & resource audit

- [ ] Every fan-out states `concurrency`, sized to the downstream; zero `Promise.all`
- [ ] Every external call sits in `Async.withTimeout`, and the signal is threaded into the client/driver
- [ ] Retries use `Async.retry` with a `retriable` **field** predicate, `Async.backoff` with injected `Random` jitter, and the request signal
- [ ] Idempotency keys on retried writes; compensation list on multi-step writes (`concurrency.md`)
- [ ] One `AbortController` for shutdown; resources register disposers and close in reverse; readiness fails while draining
- [ ] Logs go through the `Logger` port as JSON events with `requestId` and the error tag as a field

## 6. Performance audit

- [ ] Per-element paths (anything in a loop over many items) use early returns: no closures, spread, `.map().filter()` chains, or combinators per item
- [ ] `R.traverse` / pre-sized loops rather than `R.all(items.map(f))` on hot paths; unit-like failures use singleton error objects
- [ ] JSON is parsed once at the boundary and never re-serialized internally
- [ ] If a `bench/` exists, `node bench/<hot-path>.ts --check` passes its ratio and the table is in the PR when a number moved

## 7. Test audit

- [ ] Every decoder has an arbitrary that goes through it, a round-trip property, and a never-throws/never-mutates property
- [ ] Every named error in every workflow signature is reached by a test that also asserts "no partial state" against the fakes
- [ ] Every fan-out has a peak-concurrency test; fail-fast paths assert the signal fired
- [ ] Zero real sleeps for time logic (`grep -rnE 'setTimeout|sleep\(' test` → only an event-loop `tick` helper); `Cap.controlledClock` / `Cap.instantSleeper` instead
- [ ] Fakes are plain objects; zero mocking libraries (`grep -rnE 'vi\.mock|jest\.mock|mockall|sinon' test` → zero)
- [ ] Coverage thresholds configured and met
- [ ] `pnpm check` (typecheck + invariants + tests + bench ratio) was **actually run** and its output is pasted in the hand-off. Never claim green without running

## 8. Checklist sweep

Open each reference file used during the task and walk its end-of-file checklist against the diff. Report the result honestly: if an item is unmet, either fix it or state explicitly why it does not apply. Then re-run section 1 — fixes made during the sweep tend to introduce exactly the constructs section 1 catches.
