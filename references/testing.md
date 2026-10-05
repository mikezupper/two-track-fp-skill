# Testing — Properties First, Fakes over Mocks

From [The Property-Based Testing series](https://fsharpforfunandprofit.com/series/property-based-testing/): example tests prove your code works for the cases you thought of; property tests attack the ones you didn't. The architecture — a synchronous pure core, effects behind a capability record — is what makes both cheap: `total(lines)` needs no runtime, no fixture, no fake; a workflow over `deps` needs a 20-line plain object, not a framework. Nothing here needs a mocking library, a test clock plugin, or a schema runtime.

Stack: **vitest 5 + fast-check 4**, both dev dependencies. `Cap.controlledClock`, `Cap.instantSleeper`, `Cap.seededRandom`, `Cap.sequentialIds` ship in the library. Verified against two-track 0.1.0 (October 2026).

## The test pyramid

| Tier | Tooling | Volume |
|---|---|---|
| 1. **Pure domain functions** (`domain/`) | plain `it` + `fc.assert`. No async, no fakes, no capabilities | **most tests** |
| 2. **Workflows** (`workflows/`) | `it` with a hand-written `deps` fake + controlled capabilities | a solid layer |
| 3. **Adapters / integration** (`infra/`) | a real database in a container, a real HTTP server on port 0 | a few, deliberately |

Tier 1 is large *because* logic was pushed into the pure core. If a calculation needs a fake to test it, the calculation is in the wrong directory — move it into `domain/`.

## Arbitraries live next to decoders

There is no schema runtime to derive generators from, so each decoder gets a hand-written fast-check arbitrary in the same module, and the arbitrary **goes through the decoder** so every generated value is valid by construction. A generator that bypasses the decoder tests a type you don't ship. The shipped form of the `viaDecoder` helper below is `arbDecoded` from `two-track/testing`; the hand-written version is shown so the mechanism is visible.

```ts
// Arbitraries next to decoders: two ways to generate values that are valid BY CONSTRUCTION.
import fc from "fast-check";
import { D, type Infer, type Result, type DecodeError } from "two-track";

export const Email = D.brand(D.pattern(/^[a-z0-9]+@[a-z0-9]+\.[a-z]{2,}$/, "expected email"), "Email");
export const Cents = D.brand(D.min(D.integer, 0), "Cents");
export type Email = Infer<typeof Email>;
export type Cents = Infer<typeof Cents>;

/** Lift any decoder into a generator: generate the wire shape, keep what decodes. Filters must reject RARELY. */
export const viaDecoder = <A>(wire: fc.Arbitrary<unknown>, decoder: D.Decoder<A>): fc.Arbitrary<A> =>
  wire
    .map((raw): Result<DecodeError, A> => decoder.decode(raw))
    .filter((r): r is { readonly ok: true; readonly value: A } => r.ok)
    .map((r) => r.value);

// 1. Build the wire value so it is almost always valid, then route it THROUGH the decoder.
export const arbEmail: fc.Arbitrary<Email> = viaDecoder(
  fc
    .tuple(fc.stringMatching(/^[a-z0-9]{1,12}$/), fc.stringMatching(/^[a-z0-9]{1,8}$/), fc.constantFrom("com", "io", "dev"))
    .map(([user, host, tld]) => `${user}@${host}.${tld}`),
  Email,
);

// 2. Numeric brands: generate inside the refinement's range and decode.
export const arbCents: fc.Arbitrary<Cents> = viaDecoder(fc.integer({ min: 0, max: 10_000_000 }), Cents);

export const Line = D.struct({ sku: D.nonEmptyString, qty: D.min(D.integer, 1), unitPrice: Cents });
export type Line = Infer<typeof Line>;
export const arbLine: fc.Arbitrary<Line> = fc.record({
  sku: fc.stringMatching(/^[A-Z]{3}-[0-9]{3}$/),
  qty: fc.integer({ min: 1, max: 50 }),
  unitPrice: arbCents,
});
```

Generator gotchas: a `.filter` that rejects most values exhausts the run (`Property failed … too many pre-condition failures`) — generate the shape first so the decoder almost always accepts. Keep regexes in `fc.stringMatching` flag-free and character-class explicit.

## Round-trip every boundary decoder

Minimum bar, one block per decoder: `decode(x) == ok(x)` for generated `x`, the same through `D.json(Decoder).decode(JSON.stringify(x))`, and "never throws, never mutates" on `fc.anything()`. Then pin a few wire failures with their exact `D.formatIssues` text — those strings are what clients see.

```ts
// Round-trip and never-throws properties for every boundary decoder.
import { describe, it } from "vitest";
import fc from "fast-check";
import { D, ok } from "two-track";
import { Line, arbLine } from "../domain/arbitraries.ts";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

describe("Line decoder", () => {
  it("round-trips every generated value (decode ∘ identity = ok)", () => {
    fc.assert(fc.property(arbLine, (line) => same(Line.decode(line), ok(line))));
  });

  it("never throws and never mutates, whatever arrives", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const before = JSON.stringify(raw);
        const r = Line.decode(raw);
        return typeof r.ok === "boolean" && JSON.stringify(raw) === before;
      }),
    );
  });
});
```

## Laws for anything you add to `src/lib/`

Every project-local combinator ships with the property that proves its algebra, modelled on the library's own `test/result.test.ts` (functor identity/composition, monad left/right identity/associativity). Associativity, zeros, and naturality (commuting with `map`) are the usual trio:

```ts
// Laws for any combinator you add in src/lib/, modelled on two-track's own test/result.test.ts.
import { describe, it } from "vitest";
import fc from "fast-check";
import { err, ok, type Result } from "two-track";

/** A project-local combinator: keep the first Ok of two independent attempts. */
export const firstOk = <E, A>(a: Result<E, A>, b: () => Result<E, A>): Result<E, A> => (a.ok ? a : b());

const arbResult = <A>(arb: fc.Arbitrary<A>): fc.Arbitrary<Result<string, A>> => fc.oneof(arb.map(ok), fc.string().map(err));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

describe("firstOk laws", () => {
  it("is associative", () => {
    fc.assert(
      fc.property(arbResult(fc.integer()), arbResult(fc.integer()), arbResult(fc.integer()), (a, b, c) =>
        same(firstOk(firstOk(a, () => b), () => c), firstOk(a, () => firstOk(b, () => c))),
      ),
    );
  });
  it("Ok is a left zero: the thunk is never evaluated", () => {
    fc.assert(fc.property(fc.integer(), arbResult(fc.integer()), (n, b) => same(firstOk(ok(n), () => b), ok(n))));
  });
});
```

## `two-track/testing`: laws and round-trips in one line

The library proves its own functor/monad laws and decoder round-trips with fast-check and ships those properties as helpers (two-track decision 0011). fast-check is passed in as the first argument — it is never a dependency of the package — so the helpers work with whatever `fc` your project installed. Use them for **every** custom combinator in `src/lib/` and **every** boundary decoder.

```ts
import fc from "fast-check";
import { describe, it } from "vitest";
import { D, O, R, type Result } from "two-track";
import { arbDecoded, arbOption, arbResult, decoderDoesNotMutate, decoderNeverThrows, decoderRoundTrip, functorLaws, monadLaws } from "two-track/testing";

const Email = D.brand(D.pattern(/^[^\s@]+@[^\s@]+$/, "expected email"), "Email");
const Line = D.struct({ sku: D.nonEmptyString, qty: D.min(D.integer, 1), gift: D.option(D.boolean) });

// a custom combinator: Result that remembers how many steps ran
type Traced<E, A> = Result<E, { readonly value: A; readonly steps: number }>;
const traced = <A>(a: A): Traced<never, A> => R.ok({ value: a, steps: 0 });
const mapTraced = <E, A, B>(t: Traced<E, A>, f: (a: A) => B): Traced<E, B> => R.map(t, (x) => ({ value: f(x.value), steps: x.steps }));
const andThenTraced = <E, A, E2, B>(t: Traced<E, A>, f: (a: A) => Traced<E2, B>): Traced<E | E2, B> =>
  R.andThen(t, (x) => R.map(f(x.value), (y) => ({ value: y.value, steps: x.steps + y.steps + 1 })));

describe("laws", () => {
  const arbTraced = arbResult(fc, fc.string(), fc.record({ value: fc.integer(), steps: fc.nat() }));
  it("Traced is a lawful functor", () => functorLaws(fc, { arb: arbTraced, map: mapTraced }));
  it("Traced is a lawful monad up to the step count", () =>
    monadLaws(fc, {
      arb: arbTraced,
      of: traced,
      andThen: andThenTraced,
      equals: (a, b) => JSON.stringify(R.map(a, (x) => x.value)) === JSON.stringify(R.map(b, (x) => x.value)),
    }));
  it("Option is lawful (sanity: the library's own)", () => functorLaws(fc, { arb: arbOption(fc, fc.integer()), map: O.map }));
});

describe("decoders", () => {
  it("Email round-trips, never throws, never mutates", () => {
    decoderRoundTrip(fc, Email, arbDecoded(fc, fc.emailAddress(), Email));
    decoderNeverThrows(fc, Email);
  });
  it("Line round-trips through its wire encoding", () => {
    const arbLine = arbDecoded(fc, fc.record({ sku: fc.string({ minLength: 1 }), qty: fc.integer({ min: 1 }), gift: fc.option(fc.boolean(), { nil: null }) }), Line);
    decoderRoundTrip(fc, Line, arbLine, { encode: (l) => ({ ...l, gift: O.toNullable(l.gift) }) });
    decoderDoesNotMutate(fc, Line, fc.anything());
  });
});
```

A law helper throws (through fast-check, with the shrunken counter-example) when the law fails; the `equals` hook is for containers whose equality is coarser than structural, as in the `steps` example. `monadLaws` derives its Kleisli arrows from `arb`/`of`/`andThen` unless you pass `arbKleisli`. The arbitraries these helpers return are typed structurally, so hand them to the helpers freely but add `as fc.Arbitrary<T>` if you pass one back into `fc.record` or `fc.func`.

## Invariants and state machines

The property patterns to reach for (from Wlaschin's [Choosing properties](https://fsharpforfunandprofit.com/posts/property-based-testing-2/)): round-trip, invariants (totals non-negative, same length), idempotence (`normalize ∘ normalize = normalize`, a webhook applied twice = once), commutativity (order-independent totals), oracle (fast implementation = obvious one), and "hard to prove, easy to verify". Avoid "the code equals the code" properties that re-implement the function under test.

For a tagged-union state machine, generate random command sequences, fold them through the transition function, and compare against the simplest possible model of legality. fast-check shrinks a failure to the shortest offending sequence, which you then pin as a regression test.

```ts
// A tagged-union state machine checked against a simple model (fold-based; no classes, no runtime).
import { describe, it } from "vitest";
import fc from "fast-check";
import { assertNever, err, ok, tagged, type Result, type Tagged } from "two-track";
import { arbLine, type Cents, type Line } from "../domain/arbitraries.ts";

type Draft = Tagged<"Draft", { lines: ReadonlyArray<Line> }>;
type Placed = Tagged<"Placed", { total: Cents }>;
type Paid = Tagged<"Paid", { total: Cents }>;
export type OrderState = Draft | Placed | Paid;

type Command = Tagged<"Add", { line: Line }> | Tagged<"Place"> | Tagged<"Pay">;
const IllegalTransition = tagged("IllegalTransition")<{ from: OrderState["_tag"]; command: Command["_tag"] }>();
type IllegalTransition = ReturnType<typeof IllegalTransition>;

export const step = (s: OrderState, c: Command): Result<IllegalTransition, OrderState> => {
  switch (c._tag) {
    case "Add":
      return s._tag === "Draft" ? ok({ _tag: "Draft", lines: [...s.lines, c.line] }) : err(IllegalTransition({ from: s._tag, command: c._tag }));
    case "Place":
      return s._tag === "Draft" && s.lines.length > 0
        ? ok({ _tag: "Placed", total: s.lines.reduce((acc, l) => acc + l.qty * l.unitPrice, 0) as Cents })
        : err(IllegalTransition({ from: s._tag, command: c._tag }));
    case "Pay":
      return s._tag === "Placed" ? ok({ _tag: "Paid", total: s.total }) : err(IllegalTransition({ from: s._tag, command: c._tag }));
    default:
      return assertNever(c);
  }
};

const arbCommand: fc.Arbitrary<Command> = fc.oneof(
  arbLine.map((line): Command => ({ _tag: "Add", line })),
  fc.constant<Command>({ _tag: "Place" }),
  fc.constant<Command>({ _tag: "Pay" }),
);

describe("order state machine", () => {
  it("no command sequence reaches an illegal state; every rejection names the transition", () => {
    // Model: successful Place/Pay happen at most once each, Pay only after Place.
    fc.assert(
      fc.property(fc.array(arbCommand, { maxLength: 30 }), (commands) => {
        let state: OrderState = { _tag: "Draft", lines: [] };
        let placed = 0;
        let paid = 0;
        for (const c of commands) {
          const r = step(state, c);
          if (r.ok) {
            state = r.value;
            if (c._tag === "Place") placed++;
            if (c._tag === "Pay") paid++;
          }
        }
        const legal = placed <= 1 && paid <= 1 && (paid === 0 || placed === 1);
        const consistent = state._tag === "Paid" ? paid === 1 : state._tag === "Placed" ? placed === 1 && paid === 0 : placed === 0;
        return legal && consistent;
      }),
      { numRuns: 500 },
    );
  });
});
```

`fc.commands` (model-based testing with explicit command classes) exists for complex stateful models; the fold above covers most domain state machines with no classes. Keep `total`-style invariants (order-independent, non-negative) as their own one-line properties.

## Workflows: fakes as values, capabilities under control

A fake is a plain object implementing the port interface, plus whatever state the test wants to read back. `Cap.controlledClock` makes time a value you set; `Cap.instantSleeper` makes retry/backoff instant while recording every requested delay; `Cap.seededRandom` makes jitter reproducible. Never `setTimeout` in a workflow test, never a real network.

```ts
// Workflow tests: fakes as plain objects, controlled capabilities, error tracks as API surface.
import { describe, expect, it } from "vitest";
import { Async, Cap, O, err, ok, tagged, type AsyncResult, type Option } from "two-track";
import { type Cents, type Email } from "../domain/arbitraries.ts";

const NotFound = tagged("CustomerNotFound")<{ email: Email }>();
const Declined = tagged("PaymentDeclined")<{ retriable: boolean }>();
type ChargeError = ReturnType<typeof NotFound> | ReturnType<typeof Declined>;

type Deps = {
  readonly customers: { readonly find: (email: Email) => AsyncResult<never, Option<{ readonly id: string }>> };
  readonly payments: { readonly charge: (id: string, amount: Cents, signal: AbortSignal) => AsyncResult<ReturnType<typeof Declined>, void> };
  readonly ledger: { readonly record: (id: string, amount: Cents, at: number) => AsyncResult<never, void> };
  readonly clock: Cap.Clock;
  readonly sleeper: Cap.Sleeper;
};

export const chargeCustomer = async (deps: Deps, email: Email, amount: Cents): AsyncResult<ChargeError, { readonly at: number }> => {
  const found = await deps.customers.find(email);
  if (!found.ok) return found;
  if (!found.value.some) return err(NotFound({ email }));
  const id = found.value.value;
  const charged = await Async.retry((_, signal) => deps.payments.charge(id.id, amount, signal), {
    attempts: 3,
    delay: Async.backoff({ baseMs: 100 }),
    retriable: (e) => e.retriable,
    sleeper: deps.sleeper,
  });
  if (!charged.ok) return charged;
  const at = deps.clock.now();
  await deps.ledger.record(id.id, amount, at);
  return ok({ at });
};

// A fake is a plain object plus the state the test wants to inspect. No mocking library.
const fakeDeps = (opts: { readonly known: ReadonlyArray<string>; readonly declines: number }) => {
  const ledger: Array<{ id: string; amount: number; at: number }> = [];
  const sleeper = Cap.instantSleeper();
  let declines = opts.declines;
  const deps: Deps = {
    customers: { find: async (email) => ok(opts.known.includes(email) ? O.some({ id: `c-${email}` }) : O.none) },
    payments: { charge: async () => (declines-- > 0 ? err(Declined({ retriable: true })) : ok(undefined)) },
    ledger: { record: async (id, amount, at) => (ledger.push({ id, amount, at }), ok(undefined)) },
    clock: Cap.controlledClock(1_700_000_000_000),
    sleeper,
  };
  return { deps, ledger, sleeper };
};

const email = "a@b.com" as Email;
const amount = 999 as Cents;

describe("chargeCustomer", () => {
  it("retries a transient decline without real time passing, then records once", async () => {
    const { deps, ledger, sleeper } = fakeDeps({ known: [email], declines: 2 });
    const r = await chargeCustomer(deps, email, amount);
    expect(r).toEqual(ok({ at: 1_700_000_000_000 }));
    expect(ledger).toHaveLength(1);
    expect(sleeper.calls).toEqual([100, 200]); // delays requested, none actually waited
  });

  it("error track: unknown customer surfaces the tag and leaves no partial state", async () => {
    const { deps, ledger } = fakeDeps({ known: [], declines: 0 });
    const r = await chargeCustomer(deps, email, amount);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error._tag).toBe("CustomerNotFound");
    expect(ledger).toEqual([]);
  });
});
```

## Error tracks are API surface

Test them like one. For each named error in a workflow's signature there is a test that (1) drives the workflow onto that track, (2) asserts the tag (and the fields a handler needs), and (3) asserts that **the failure left no partial state** in the fakes. Never `try/catch` in tests; a thrown exception is a test failure, which is the point.

## Concurrency: assert the bound, observe the abort

```ts
// Concurrency tests: assert the bound and observe fail-fast cancellation through the signal.
import { describe, expect, it } from "vitest";
import { Async, err, ok } from "two-track";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1)); // 1 ms yield; the only timer in the test file

describe("fan-out", () => {
  it("never exceeds the configured concurrency and keeps input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const r = await Async.mapConcurrent(
      [3, 1, 2, 5, 4],
      async (n) => ((peak = Math.max(peak, ++inFlight)), await tick(), inFlight--, ok(n * 10)),
      { concurrency: 2 },
    );
    expect(r).toEqual(ok([30, 10, 20, 50, 40]));
    expect(peak).toBe(2);
  });

  it("aborts in-flight work on the first failure and stops launching more", async () => {
    const started: number[] = [];
    const sawAbort: number[] = [];
    const r = await Async.mapConcurrent(
      [0, 1, 2, 3, 4, 5, 6, 7],
      async (i, _index, signal) => {
        started.push(i);
        if (i === 1) return err("boom");
        await tick();
        if (signal.aborted) sawAbort.push(i);
        return ok(i);
      },
      { concurrency: 2 },
    );
    expect(r).toEqual(err("boom"));
    expect(started.length).toBeLessThan(8);
    expect(sawAbort).toContain(0);
  });
});
```

The 1 ms `tick` is the one place a timer is acceptable in a test file: it yields the event loop so concurrency can be observed. Never use timers to test retry delays or timeouts — those take a `Sleeper`/`Clock`.

## Time-dependent code gets properties too

Example tests of retry, timeouts and lanes show the schedules you thought of. The bugs live in the schedules you did not — a downstream consumer found that `Async.retry` ran one extra attempt when cancelled during its backoff wait, a case no example covered. For anything that sleeps, races or coordinates triggers, generate the schedule: a fast-check `asyncProperty` over a random sequence of events (call, resolve run *i*, fire pending sleep *j*, advance the clock, abort) driven through `Cap.manualSleeper()` and `Cap.controlledClock()`, asserting the invariants after every step and the leak conditions at the end (`sleeper.pending()` empty, no abort listeners left on a counting signal wrapper). The library's own `test/*.properties.test.ts` are the template, and its invariants script refuses a new export of `async`/`lanes`/`capabilities` without one; adopt the same rule for your `src/lib/` helpers.

## Test-only immutability check

`Object.freeze` is banned in `src/` (decision 0003: 10–20x measured). In tests it is free and useful: a frozen fixture makes any accidental mutation throw under strict-mode ESM.

```ts
import { expect, it } from "vitest";
import { Line, type Cents } from "../domain/arbitraries.ts";
import { R } from "two-track";

const total = (lines: ReadonlyArray<Line>): number => lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);

it("total does not mutate its input", () => {
  // TEST-ONLY (decision 0003): a frozen fixture turns any accidental mutation into a thrown TypeError.
  const line = R.unwrapOrElse(Line.decode({ sku: "ABC-123", qty: 2, unitPrice: 1999 }), (e) => { throw new Error(String(e)); });
  const fixture: ReadonlyArray<Line> = Object.freeze([Object.freeze(line)]);
  expect(total(fixture)).toBe(3998);
  void (0 as Cents);
});
```

## Coverage as a gate

```ts
// vitest.config.ts — thresholds make coverage a gate, not a report.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: { provider: "v8", include: ["src/**/*.ts"], exclude: ["src/main.ts"], thresholds: { lines: 95, branches: 90 } },
  },
});
```

`pnpm test` runs `vitest run --coverage`; the structural invariants test (`test/architecture.test.ts`, see `scaffold.md`) runs in the same command so drift fails the suite, not just a lint step.

## Rules

- No mocking libraries. Fakes are plain objects implementing your ports; stateful fakes expose their state as plain arrays/maps.
- Deterministic always: controlled clock, instant sleeper, seeded random, pinned `{ seed }` (or the failure's `path`) to reproduce a property failure. No network in tiers 1–2.
- Test names state behaviour ("retries a transient decline"), not implementation ("calls charge three times").
- A bug found in production or by a property becomes a pinned regression test with the shrunk counterexample.
- Run the suite and paste the output when you claim it is green. Never claim green without running.

## Checklist

- [ ] Every helper in `src/lib/` that sleeps, races or coordinates triggers has a schedule-generating property with leak checks, not only examples
- [ ] Every custom combinator has `functorLaws`/`monadLaws`; every boundary decoder has `decoderRoundTrip` + `decoderNeverThrows` from `two-track/testing`

- [ ] Every decoder has an arbitrary that goes through it, a round-trip property, a JSON round-trip, and a never-throws/never-mutates property
- [ ] Every money/quantity calculation has invariants (non-negative, order-independent, no float drift)
- [ ] Every state machine has a command-sequence property against a simple model; its illegal transitions produce typed errors
- [ ] Every combinator in `src/lib/` has law properties (associativity/identity/naturality as applicable)
- [ ] Every named error in every workflow signature has a test that reaches it and asserts no partial state
- [ ] Every fan-out has a peak-concurrency test; fail-fast paths assert the signal fired
- [ ] Zero `setTimeout`/real sleeps for time logic; `Cap.controlledClock` + `Cap.instantSleeper` throughout
- [ ] Zero mocking libraries; fakes are plain objects
- [ ] Coverage thresholds configured and passing; `pnpm check` output pasted in the report
