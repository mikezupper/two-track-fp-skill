# Exhaustive Pattern Matching — `match`, `matchBy`, `switch` + `assertNever`

Every inspection of a domain union must fail to compile when a variant is added until the new case is handled. That compile error is the feature. `two-track` gives you three forms that all have it — `match` (expression over `_tag`), `matchBy` (expression over any discriminant key), and `switch` closed by `assertNever` (statements) — and none of them has a catch-all, because a `default` silently absorbs future variants, which is the bug exhaustive matching exists to prevent. At runtime `match` is one property lookup; there is nothing to pay for.

Verified against two-track 0.1.0 (October 2026).

## `match` on `_tag` — the common case

Variants and errors are `Tagged<"Name", Fields>` built with `tagged`. `match` takes the value and an object with exactly one handler per tag; each handler receives the narrowed variant.

```ts
import { match, tagged, type Tagged } from "two-track";

export type Draft = Tagged<"Draft", { items: ReadonlyArray<string> }>;
export type Placed = Tagged<"Placed", { items: readonly [string, ...string[]]; placedAt: number }>;
export type Paid = Tagged<"Paid", { receipt: string; paidAt: number }>;
export type Shipped = Tagged<"Shipped", { tracking: string }>;
export type Cancelled = Tagged<"Cancelled", { reason: string }>;
export type OrderState = Draft | Placed | Paid | Shipped | Cancelled;

export const Draft = tagged("Draft")<{ items: ReadonlyArray<string> }>();
export const Cancelled = tagged("Cancelled")<{ reason: string }>();

// Exhaustive by type: every tag of OrderState must appear as a key.
export const describe = (s: OrderState): string =>
  match(s, {
    Draft: ({ items }) => `draft with ${items.length} items`,
    Placed: ({ placedAt }) => `placed at ${placedAt}`,
    Paid: ({ receipt }) => `paid, receipt ${receipt}`,
    Shipped: ({ tracking }) => `shipped: ${tracking}`,
    Cancelled: ({ reason }) => `cancelled: ${reason}`,
  });

// Two cases sharing behaviour: name the handler once, list both keys.
// (Adding a 6th state to OrderState makes this fail to compile:
//  "Property 'Refunded' is missing in type '{ Draft: ...; ... }'".)
const notOpen = (): boolean => false;
export const isOpen = (s: OrderState): boolean =>
  match(s, { Draft: () => true, Placed: () => true, Paid: () => true, Shipped: notOpen, Cancelled: notOpen });
```

Rules:
- The handler object is a `Cases<T, R>`; a missing key is a type error, an extra key is a type error. Both are what you want.
- When several variants share behaviour, write one named function and point each key at it. Do not reach for a fallback — the duplication of five characters per key is the price of the compile error you will get when a sixth variant appears.
- Put a matcher used in more than one place next to the type it matches, exported, with the type's name in its own (`describeOrderState`, `orderStateIsOpen`).

## `matchBy` — a custom discriminant key

Wire shapes and third-party unions rarely use `_tag`. `matchBy(key, value, cases)` is the same guarantee over any string-literal field.

```ts
import { matchBy } from "two-track";

export type Shape =
  | { readonly kind: "circle"; readonly radius: number }
  | { readonly kind: "square"; readonly side: number };

export const area = (s: Shape): number =>
  matchBy("kind", s, { circle: ({ radius }) => Math.PI * radius * radius, square: ({ side }) => side * side });
```

Prefer `_tag` for your own unions so `match`, `hasTag`, and the error conventions all line up; use `matchBy` at the edge where the shape is not yours.

## `switch` + `assertNever` — when you need statements

Side effects, logging, multiple early returns, or fall-through grouping read better as a `switch`. Close it with `default: return assertNever(x)`. If a case is missing, `x` is not `never` and the call does not type-check. If it is ever reached at runtime, a value lied about its type at a boundary, and `assertNever` throws — the one sanctioned defect.

```ts
import { assertNever } from "two-track";
import type { OrderState } from "./order-state.ts";

export const shippingLabel = (s: OrderState, log: (line: string) => void): string => {
  switch (s._tag) {
    case "Draft":
    case "Placed":
      return "not yet payable";
    case "Paid":
      log(`printing label for receipt ${s.receipt}`);
      return `LABEL-${s.receipt}`;
    case "Shipped":
      return `already shipped ${s.tracking}`;
    case "Cancelled":
      return "cancelled";
    default:
      return assertNever(s, "OrderState");
  }
};
```

Never write a `default` that does anything else over a domain union. `default: return fallback` is the catch-all this file exists to ban.

## Narrowing collections with `hasTag`

`hasTag("Tag")` is a type guard; `filter` with it produces an array of the one variant.

```ts
import { hasTag, some, none, type Option } from "two-track";
import type { OrderState } from "./order-state.ts";

export const trackingCodes = (states: ReadonlyArray<OrderState>): ReadonlyArray<string> =>
  states.filter(hasTag("Shipped")).map((s) => s.tracking);

// A partial match is an Option, stated explicitly — never `undefined` from a missing case.
export const paidAt = (s: OrderState): Option<number> => (s._tag === "Paid" ? some(s.paidAt) : none);
```

A partial inspection ("the paid-at time, if paid") is a function returning `Option`. Make the partiality visible in the return type instead of leaving a case out of a matcher.

## Nested unions and the reason pattern

When one failure has several causes a caller may react to differently, model one outer tag with a tagged `reason` field rather than widening the error union with many siblings. The outer `match` stays short; the inner `match` keeps handling precise; both are exhaustive.

```ts
import { R, O, match, tagged, type Result, type Option } from "two-track";

export const CardExpired = tagged("CardExpired")();
export const InsufficientFunds = tagged("InsufficientFunds")<{ shortBy: number }>();
export const FraudSuspected = tagged("FraudSuspected")<{ score: number }>();
export type ChargeReason =
  | ReturnType<typeof CardExpired>
  | ReturnType<typeof InsufficientFunds>
  | ReturnType<typeof FraudSuspected>;

export const ChargeFailed = tagged("ChargeFailed")<{ reason: ChargeReason }>();
export const OrderNotFound = tagged("OrderNotFound")<{ orderId: string }>();
export type CheckoutError = ReturnType<typeof ChargeFailed> | ReturnType<typeof OrderNotFound>;

export const userMessage = (e: CheckoutError): string =>
  match(e, {
    OrderNotFound: ({ orderId }) => `order ${orderId} does not exist`,
    ChargeFailed: ({ reason }) =>
      match(reason, {
        CardExpired: () => "your card has expired",
        InsufficientFunds: ({ shortBy }) => `you are short by ${shortBy} cents`,
        FraudSuspected: () => "please contact your bank",
      }),
  });

// Result and Option have their own two-case closers.
export const render = (r: Result<CheckoutError, { readonly id: string }>): string =>
  R.match(r, (order) => `created ${order.id}`, userMessage);

export const greeting = (name: Option<string>): string => O.match(name, (n) => `hello ${n}`, () => "hello");
```

## Closers — pick deliberately

| You have | Close with | Returns | Notes |
|---|---|---|---|
| A tagged union value | `match(value, cases)` | `R` | Exhaustive; one handler per `_tag` |
| A union with another discriminant | `matchBy("kind", value, cases)` | `R` | Exhaustive over that key's literals |
| Statements / effects per case | `switch (v._tag) … default: return assertNever(v)` | whatever the arms return | The `default` is the proof, not a fallback |
| A `Result` | `R.match(r, onOk, onErr)` | `B` | Or `if (!r.ok) return r;` to stay on the railway |
| An `Option` | `O.match(o, onSome, onNone)` | `B` | Or `O.unwrapOr` when a fallback is genuinely correct |
| An array of a union | `xs.filter(hasTag("T"))` | `T[]` narrowed | Then map freely |
| "The X, if present" | a function returning `Option<X>` | `Option<X>` | Partiality in the type, never a missing case |

## Rules

- Domain variant inspection goes through `match`, `matchBy`, or `switch` + `assertNever`. No `if (x._tag === …)` ladders beyond a single guard that returns an `Option`.
- No `default` arm that does anything except `return assertNever(x)`. No `?? fallback` after a lookup table keyed by tag.
- Conditionals on booleans or numbers that choose between *behaviours* of a domain concept usually mean a union is missing. Fix the model, not the branch.
- A union crossing a boundary is decoded with `D.taggedUnion("_tag", {...})` (see `boundaries.md`) so the value that reaches `match` cannot lie about its tag.
- Reused matchers are named, exported, and colocated with the type.

## Checklist

- [ ] Every inspection of a domain union is `match`, `matchBy`, or `switch` + `assertNever`
- [ ] No `default` arm with behaviour; no `if/else` ladder over `_tag`
- [ ] Shared behaviour across variants is one named handler listed under each key
- [ ] Partial inspections return `Option`, not `undefined`
- [ ] One failure with several causes is one tag with a tagged `reason`, matched in two exhaustive levels
- [ ] Errors are closed at the edge with `match` into statuses/messages; mid-pipeline code lets them flow
- [ ] `hasTag` is used to narrow arrays instead of casts
- [ ] Reused matchers are named and live next to the type
