# Designing with Types

From [Designing with Types](https://fsharpforfunandprofit.com/series/designing-with-types/) and [Parse, don't validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/): the type system is the first line of defense, and time spent here removes whole categories of tests and production bugs. In `two-track` the tools are branded primitives produced by decoders, `readonly` records, tagged unions with per-state data, `Option` for absence, and `NonEmptyArray` — all of which compile to plain objects and strings. **Always model the types before writing logic.**

Verified against two-track 0.1.0 (October 2026).

## Branded primitives — the decoder is the smart constructor

A brand is a compile-time fiction: `Brand<string, "UserId">` is a string at runtime, which is why it is free. It is also why it can be forged with `as` — so the **only** place a brand is applied is `D.brand`, after the checks that justify it. The self-review grep rejects `as Brand<` and `as unknown as` everywhere else.

```ts
import { D, R, type Infer } from "two-track";

// The decoder IS the smart constructor: checks first, brand last. One definition gives the type,
// the runtime check, and the only legal way to obtain a value.
export const UserId = D.brand(D.pattern(/^u_[0-9a-f]{8}$/, "expected user id like u_1a2b3c4d"), "UserId");
export const Email = D.brand(D.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "expected email"), "Email");
export const Cents = D.brand(D.min(D.integer, 0), "Cents");
export const Quantity = D.brand(D.max(D.min(D.integer, 1), 1_000), "Quantity");
export type UserId = Infer<typeof UserId>;
export type Email = Infer<typeof Email>;
export type Cents = Infer<typeof Cents>;
export type Quantity = Infer<typeof Quantity>;

// Tests and fixtures: go THROUGH the decoder. A fixture that bypasses it tests a type you don't ship.
export const mustDecode = <A>(decoder: D.Decoder<A>, raw: unknown): A =>
  R.unwrapOrElse(decoder.decode(raw), (e) => assertFixture(D.formatIssues(e)));
const assertFixture = (issues: string): never => {
  // Test-only helper: a bad fixture is a bug in the test, not an expected error.
  throw new Error(`fixture does not decode: ${issues}`);
};

export const alice: Email = mustDecode(Email, "alice@example.com");
```

- Name the constant and the type identically (`Email` / `type Email`); `Infer` keeps them in lock-step.
- Refinement order: shape (`D.string`, `D.integer`) → constraint (`D.pattern`, `D.min`, `D.max`, `D.minLength`, `D.refine`) → `D.brand`. The message you pass is what users see in a 400.
- `mustDecode` lives in `test/` only. Production code obtains branded values from decoders at boundaries and never constructs them.
- Regexes in `D.pattern` must be anchored (`^…$`) and should not use flags — the same regex will drive fast-check arbitraries in tests.

## Money and quantities

Money is integer minor units behind a `Cents` brand; arithmetic re-brands its result and keeps the invariant by construction. Anything that could violate the invariant is fallible and says so.

```ts
import { ok, err, type Result } from "two-track";
import { Cents, Quantity } from "./brands.ts";
import { tagged } from "two-track";

// Money is integer minor units. Arithmetic re-brands the result; the invariant (>= 0) is kept by construction.
export const addCents = (a: Cents, b: Cents): Cents => (a + b) as Cents;
export const multiply = (price: Cents, qty: Quantity): Cents => (price * qty) as Cents;
export const sumCents = (xs: ReadonlyArray<Cents>): Cents => xs.reduce<Cents>(addCents, 0 as Cents);

// A subtraction that could go negative is fallible, and says so.
export const Overdrawn = tagged("Overdrawn")<{ shortBy: Cents }>();
export const subtractCents = (a: Cents, b: Cents): Result<ReturnType<typeof Overdrawn>, Cents> =>
  a >= b ? ok((a - b) as Cents) : err(Overdrawn({ shortBy: (b - a) as Cents }));

// Percentages: integer basis points, floor once, never floats in the domain.
export const applyDiscountBps = (amount: Cents, bps: number): Cents => Math.floor((amount * (10_000 - bps)) / 10_000) as Cents;
```

The `as Cents` inside these helpers is the one place a re-brand cast is acceptable: a total function over already-branded inputs whose result provably satisfies the brand. Keep such helpers in one `money.ts` module so the grep allowlist is a single file.

## Option, not null

`null` and `undefined` exist only in wire decoders (`D.nullable`, `D.optional`) and in boundary converters inside `infra/`. The domain uses `Option<A>`; `none` is a shared singleton that allocates nothing.

```ts
import { O, some, none, type Option } from "two-track";
import type { Email, UserId } from "./brands.ts";

// Option in the domain; null only exists at the boundary.
export type User = { readonly id: UserId; readonly email: Email; readonly displayName: Option<string> };

export const label = (u: User): string => O.unwrapOr(u.displayName, u.email);

export const rename = (u: User, name: string): User => ({ ...u, displayName: name.trim() === "" ? none : some(name.trim()) });

export const initials = (u: User): Option<string> =>
  O.map(u.displayName, (n) => n.split(" ").map((part) => part.charAt(0).toUpperCase()).join(""));

// Boundary converters are used in infra/, never in domain/.
export const fromRow = (row: { readonly display_name: string | null }): Option<string> => O.fromNullable(row.display_name);
export const toRow = (u: User): { readonly display_name: string | null } => ({ display_name: O.toNullable(u.displayName) });
```

## Make illegal states unrepresentable — tagged unions with per-state data

Replace flag combinations and optional-field soup with a union whose each member carries exactly the data valid in that state. Transitions are pure functions returning `Result`; an illegal move is an error, not an `if`.

```ts
import { ok, err, match, tagged, type Result, type Tagged, type NonEmptyArray } from "two-track";
import type { Cents, Quantity } from "./brands.ts";

type Line = { readonly sku: string; readonly qty: Quantity; readonly unitPrice: Cents };

// Each state carries exactly the data valid in that state. No `isPaid: boolean; paidAt?: number`.
export type OrderState =
  | Tagged<"Draft", { lines: ReadonlyArray<Line> }>
  | Tagged<"Placed", { lines: NonEmptyArray<Line>; placedAt: number }>
  | Tagged<"Paid", { lines: NonEmptyArray<Line>; paidAt: number; receipt: string }>
  | Tagged<"Shipped", { tracking: string; shippedAt: number }>
  | Tagged<"Cancelled", { reason: string; cancelledAt: number }>;

export const EmptyOrder = tagged("EmptyOrder")();
export const InvalidTransition = tagged("InvalidTransition")<{ from: OrderState["_tag"]; to: OrderState["_tag"] }>();
export type EmptyOrder = ReturnType<typeof EmptyOrder>;
export type InvalidTransition = ReturnType<typeof InvalidTransition>;

// Transitions are pure functions from (state, inputs) to Result<Error, state>. Illegal moves are errors, not ifs.
export const place = (s: OrderState, now: number): Result<EmptyOrder | InvalidTransition, OrderState> => {
  if (s._tag !== "Draft") return err(InvalidTransition({ from: s._tag, to: "Placed" }));
  const [first, ...rest] = s.lines;
  if (first === undefined) return err(EmptyOrder({}));
  return ok({ _tag: "Placed", lines: [first, ...rest], placedAt: now });
};

export const pay = (s: OrderState, receipt: string, now: number): Result<InvalidTransition, OrderState> =>
  s._tag === "Placed" ? ok({ _tag: "Paid", lines: s.lines, paidAt: now, receipt }) : err(InvalidTransition({ from: s._tag, to: "Paid" }));

// Reading a state: exhaustive by construction. Adding a variant breaks every match until handled.
export const describe = (s: OrderState): string =>
  match(s, {
    Draft: ({ lines }) => `draft with ${lines.length} lines`,
    Placed: ({ placedAt }) => `placed at ${placedAt}`,
    Paid: ({ receipt }) => `paid, receipt ${receipt}`,
    Shipped: ({ tracking }) => `shipped: ${tracking}`,
    Cancelled: ({ reason }) => `cancelled: ${reason}`,
  });
```

Smells that mean a union is missing: two booleans that are never both true; two `Option` fields of which exactly one is set; a `status: string`; a `kind` field plus `if` ladders. When a union crosses a boundary, give it a `D.taggedUnion` decoder (`references/boundaries.md`) so it is also parseable.

## Commands in, events out

Workflows take a command and return a `Result` of **events**; edges dispatch events to infrastructure. The decision is pure, so it is tested without fakes, and the same events feed persistence, messaging, and audit logs.

```ts
import { ok, err, match, type Result, type Tagged, type Option } from "two-track";
import type { Cents, Email, UserId } from "./brands.ts";

// Commands in, events out: the workflow decides; the edge dispatches. Decisions stay pure and testable.
export type Command = Tagged<"ChangeEmail", { userId: UserId; email: Email }> | Tagged<"TopUp", { userId: UserId; amount: Cents }>;

export type Event =
  | Tagged<"EmailChanged", { userId: UserId; from: Email; to: Email }>
  | Tagged<"BalanceToppedUp", { userId: UserId; newBalance: Cents }>;

export type UserNotFound = Tagged<"UserNotFound", { userId: UserId }>;
export type NoChange = Tagged<"NoChange">;
type Decision = Result<UserNotFound | NoChange, ReadonlyArray<Event>>;

type Account = { readonly id: UserId; readonly email: Email; readonly balance: Cents };

export const decide = (account: Option<Account>, cmd: Command): Decision => {
  if (!account.some) return err({ _tag: "UserNotFound", userId: cmd.userId });
  const acc = account.value;
  return match<Command, Decision>(cmd, {
    ChangeEmail: ({ email }) =>
      email === acc.email ? err({ _tag: "NoChange" }) : ok([{ _tag: "EmailChanged", userId: acc.id, from: acc.email, to: email }]),
    TopUp: ({ amount }) => ok([{ _tag: "BalanceToppedUp", userId: acc.id, newBalance: (acc.balance + amount) as Cents }]),
  });
};

// The edge dispatches events to infra (persist, publish, notify); the decision never touches I/O.
export const describeEvent = (e: Event): string =>
  match(e, {
    EmailChanged: ({ to }) => `email → ${to}`,
    BalanceToppedUp: ({ newBalance }) => `balance → ${newBalance}`,
  });
```

When `match` cases return different `Result` shapes, give it the result type explicitly (`match<Command, Decision>`), as above, so inference does not pick the first case's narrower type.

## Records, updates, and non-empty collections

Records are `readonly` types. An "update" is a new value built with spread; nothing is mutated in place. Contained local mutation *inside* a function with a pure signature (a counter, a pre-sized array) is idiomatic and fast.

```ts
import { ok, err, type NonEmptyArray, type Result } from "two-track";

// Records are readonly types. "Updates" are new values via spread; the old value is untouched.
export type Address = { readonly line1: string; readonly city: string; readonly postcode: string };
export type Customer = { readonly name: string; readonly address: Address; readonly tags: ReadonlyArray<string> };

export const moveTo = (c: Customer, city: string, postcode: string): Customer => ({ ...c, address: { ...c.address, city, postcode } });
export const tag = (c: Customer, t: string): Customer => (c.tags.includes(t) ? c : { ...c, tags: [...c.tags, t] });

// NonEmptyArray makes "at least one" a type, so `lines[0]` needs no check downstream.
export const nonEmpty = <A>(xs: ReadonlyArray<A>): Result<"Empty", NonEmptyArray<A>> => {
  const [first, ...rest] = xs;
  return first === undefined ? err("Empty") : ok([first, ...rest]);
};
export const head = <A>(xs: NonEmptyArray<A>): A => xs[0];

// Contained local mutation inside a pure function is idiomatic: nothing escapes mutable.
export const total = (amounts: ReadonlyArray<number>): number => {
  let acc = 0;
  for (let i = 0; i < amounts.length; i++) acc += amounts[i] as number;
  return acc;
};
```

Never `Object.freeze` (10–20x measured; decision 0003) — the `readonly` type is the guarantee. At a boundary, `D.nonEmptyArray` produces the non-empty type directly.

## Time

Time in the domain is an epoch-millisecond `Instant` brand. ISO strings are a wire format decoded at the edge; "now" comes from `Cap.Clock`, never `Date.now()`.

```ts
import { Cap, D, type Infer } from "two-track";

// Time in the domain is an epoch-millisecond Instant. Wire formats (ISO strings) are decoded at the edge;
// "now" comes from the Clock capability, never from Date.now().
export const Instant = D.brand(D.map(D.isoDate, (d) => d.getTime()), "Instant");
export type Instant = Infer<typeof Instant>;

export const DurationMs = D.brand(D.min(D.integer, 0), "DurationMs");
export type DurationMs = Infer<typeof DurationMs>;

export const plus = (t: Instant, d: DurationMs): Instant => (t + d) as Instant;
export const isExpired = (deadline: Instant, clock: Cap.Clock): boolean => clock.now() > deadline;

// Encoding back to the wire is a plain function.
export const toIso = (t: Instant): string => new Date(t).toISOString();

export const nowInstant = (clock: Cap.Clock): Instant => clock.now() as Instant;
```

## Wire shape ≠ domain shape

Rows, request bodies, responses, and messages are separate types with their own decoders. Converting between them is an explicit function in `infra/` or the edge, which is where field renames, nullability, and format changes live.

```ts
import { D, O, type Infer } from "two-track";
import { Cents, Email, UserId } from "./brands.ts";
import { Instant } from "./time.ts";

// Wire shape and domain shape are different types. Separate decoders; convert explicitly.
export const UserRow = D.struct({
  id: UserId,
  email: Email,
  display_name: D.option(D.string),      // nullable column → Option
  balance_cents: Cents,
  created_at: Instant,                   // ISO text from the driver → epoch ms
});
export type UserRow = Infer<typeof UserRow>;

export type User = { readonly id: UserId; readonly email: Email; readonly displayName: O.Option<string>; readonly balance: Cents; readonly createdAt: Instant };

export const fromRow = (r: UserRow): User => ({ id: r.id, email: r.email, displayName: r.display_name, balance: r.balance_cents, createdAt: r.created_at });

// API response: a third shape, owned by the HTTP adapter.
export type UserResponse = { readonly id: string; readonly email: string; readonly displayName: string | null; readonly balanceCents: number };
export const toResponse = (u: User): UserResponse => ({ id: u.id, email: u.email, displayName: O.toNullable(u.displayName), balanceCents: u.balance });
```

## Checklist

- [ ] No naked `string`/`number` for ids, emails, money, quantities, durations in the domain — brands from decoders
- [ ] Every brand is produced by `D.brand` after its refinements; no `as Brand<` outside the single re-brand helper module
- [ ] Money is integer minor units; fallible arithmetic returns `Result`
- [ ] No `null`/`undefined` in domain types; `Option` with `none` singleton; converters only in `infra/`
- [ ] Every lifecycle is a tagged union with per-state data; transitions return `Result`; reads use exhaustive `match`
- [ ] Workflows return events (a tagged union); edges dispatch them
- [ ] All record fields `readonly`, collections `ReadonlyArray`; updates by spread; no `Object.freeze`
- [ ] "At least one" is `NonEmptyArray`, produced by `D.nonEmptyArray` or a `nonEmpty` helper
- [ ] Time is an `Instant` brand (epoch ms) from `D.isoDate` or `Cap.Clock`; no `Date` in the domain
- [ ] Row, body, response, and message shapes have their own decoders and explicit conversion functions
