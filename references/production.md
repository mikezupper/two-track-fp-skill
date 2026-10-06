# Production Readiness

"Works on the happy path" is the starting line. Everything here is required for any deployable service, and with zero runtime dependencies each item is a port interface plus a 20–40-line adapter you can read in full. The checklist at the bottom is the definition of done. Verified against two-track 0.1.0 (October 2026).

## Observability is a capability

Logging and metrics follow the same rule as the clock: the domain never imports them, workflows receive them in `deps`/`ctx`, and the adapter is wired once in `main.ts`. Logs are JSON lines on stdout; the platform's shipper (Vector, Fluent Bit, the cloud agent) does transport. There is no `console.log` outside `infra/`, `lib/` and `main.ts` — `two-track-check`'s `no-console` enforces it; the JSON logger in `infra/logger.ts` is the one writer to stdout.

```ts
// domain/ports.ts — logging and metrics are capabilities, like the clock. The domain never imports a logger.
import { Cap } from "two-track";

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;
export type Logger = {
  readonly info: (event: string, fields?: LogFields) => void;
  readonly warn: (event: string, fields?: LogFields) => void;
  readonly error: (event: string, fields?: LogFields) => void;
  /** A child logger whose every line carries these fields (requestId, userId, …). */
  readonly with: (fields: LogFields) => Logger;
};

export type Metrics = {
  readonly counter: (name: string, labels?: LogFields) => void;
  readonly histogram: (name: string, valueMs: number, labels?: LogFields) => void;
};

// infra/logger.ts — JSON lines to stdout; the platform's log shipper does the rest.
export const jsonLogger = (clock: Cap.Clock, base: LogFields = {}): Logger => {
  const line = (level: "info" | "warn" | "error", event: string, fields?: LogFields): void => {
    process.stdout.write(`${JSON.stringify({ ts: new Date(clock.now()).toISOString(), level, event, ...base, ...fields })}\n`);
  };
  return {
    info: (event, fields) => line("info", event, fields),
    warn: (event, fields) => line("warn", event, fields),
    error: (event, fields) => line("error", event, fields),
    with: (fields) => jsonLogger(clock, { ...base, ...fields }),
  };
};

// test fake: capture lines as values
export const memoryLogger = (): Logger & { readonly lines: ReadonlyArray<{ level: string; event: string; fields: LogFields }> } => {
  const lines: Array<{ level: string; event: string; fields: LogFields }> = [];
  const make = (base: LogFields): Logger => ({
    info: (event, fields) => void lines.push({ level: "info", event, fields: { ...base, ...fields } }),
    warn: (event, fields) => void lines.push({ level: "warn", event, fields: { ...base, ...fields } }),
    error: (event, fields) => void lines.push({ level: "error", event, fields: { ...base, ...fields } }),
    with: (fields) => make({ ...base, ...fields }),
  });
  return { ...make({}), lines };
};
```

Rules: log **events** (`checkout.failed`), not sentences; put the error tag in a field so it is queryable; attach `requestId` once via `log.with(...)` so every line in the request carries it; never log a secret, a card number, or a full request body. Expected errors are `warn`, defects (an `assertNever` reached, a rejected promise that escaped `fromPromise`) are `error`.

## The edge: statuses, logs, request ids — once, exhaustively

Errors become HTTP statuses in exactly one place per transport, with `match` so a new error tag is a compile error until it has a status. Timeouts, retries, and request ids are shell concerns applied at the same edge.

```ts
// The edge: errors become statuses and log lines HERE, exhaustively, and nowhere else.
import { Async, Cap, R, match, tagged, type AsyncResult } from "two-track";
import type { Logger, Metrics } from "../domain/ports.ts";

const OrderNotFound = tagged("OrderNotFound")<{ orderId: string }>();
const PaymentDeclined = tagged("PaymentDeclined")<{ reason: string; retriable: boolean }>();
const Upstream = tagged("Upstream")<{ service: string; retriable: boolean }>();
const Timeout = tagged("Timeout")<{ service: string; afterMs: number }>();
type CheckoutError = ReturnType<typeof OrderNotFound> | ReturnType<typeof PaymentDeclined> | ReturnType<typeof Upstream> | ReturnType<typeof Timeout> | Async.Aborted;

type Ctx = { readonly requestId: string; readonly log: Logger; readonly metrics: Metrics; readonly signal: AbortSignal };
type Deps = { readonly clock: Cap.Clock; readonly ids: Cap.IdGen; readonly log: Logger; readonly metrics: Metrics };

// Per-request context: a request id from the IdGen capability and a child logger that carries it.
export const makeCtx = (deps: Deps, signal: AbortSignal): Ctx => {
  const requestId = deps.ids.next();
  return { requestId, log: deps.log.with({ requestId }), metrics: deps.metrics, signal };
};

type Response = { readonly status: number; readonly body: unknown };

export const toResponse = (ctx: Ctx, r: Awaited<AsyncResult<CheckoutError, { readonly orderId: string }>>): Response =>
  R.match<CheckoutError, { readonly orderId: string }, Response>(
    r,
    (order) => ({ status: 201, body: order }),
    (e) => {
      // Expected errors are logged at warn with the tag as a FIELD (queryable), never interpolated into the message.
      ctx.log.warn("checkout.failed", { error: e._tag, retriable: "retriable" in e ? e.retriable : false });
      ctx.metrics.counter("checkout_failed_total", { error: e._tag });
      return match(e, {
        OrderNotFound: ({ orderId }) => ({ status: 404, body: { error: "order_not_found", orderId, requestId: ctx.requestId } }),
        PaymentDeclined: ({ reason, retriable }) => ({ status: retriable ? 503 : 402, body: { error: "payment_declined", reason, requestId: ctx.requestId } }),
        Upstream: ({ service }) => ({ status: 502, body: { error: "upstream_unavailable", service, requestId: ctx.requestId } }),
        Timeout: ({ service }) => ({ status: 504, body: { error: "upstream_timeout", service, requestId: ctx.requestId } }),
        // The client went away mid-retry: nothing to retry, nothing to show. 499 is nginx's convention for exactly this.
        Aborted: () => ({ status: 499, body: { error: "client_cancelled", requestId: ctx.requestId } }),
      });
    },
  );

// Every external call: a deadline, a signal, and retry ONLY on what is transient.
export const chargeWithPolicy = (
  charge: (signal: AbortSignal) => AsyncResult<ReturnType<typeof PaymentDeclined> | ReturnType<typeof Upstream>, void>,
  deps: { readonly sleeper: Cap.Sleeper; readonly random: Cap.Random },
  parent: AbortSignal,
): AsyncResult<CheckoutError, void> =>
  Async.retry(
    (_attempt, signal) => Async.withTimeout(charge, 5_000, () => Timeout({ service: "payments", afterMs: 5_000 }), signal),
    {
      attempts: 3,
      delay: Async.backoff({ baseMs: 200, maxMs: 2_000, random: deps.random.next }),
      retriable: (e) => (e._tag === "Timeout" ? true : e.retriable),
      sleeper: deps.sleeper,
      signal: parent,
    },
  );
```

Resilience rules, all mechanical: every external call sits inside `Async.withTimeout`; the signal it hands you is passed into `fetch`/the driver (a timeout that does not cancel is a leak); retries use `Async.retry` with a `retriable` predicate reading a **field** of the error, `Async.backoff` with jitter from the injected `Random`, and the request's signal as `signal`; every fan-out is `Async.mapConcurrent` with an explicit `concurrency`; idempotency keys accompany any retried write.

## Circuit breaker

When a dependency is down, stop calling it. Thirty lines in `src/lib/`, pure over the `Clock`, state as a tagged union, no library:

```ts
// src/lib/circuit-breaker.ts — ~30 lines, pure over a Clock. State is a tagged union; no classes.
import { Cap, err, type AsyncResult } from "two-track";

type State =
  | { readonly _tag: "Closed"; readonly failures: number }
  | { readonly _tag: "Open"; readonly until: number }
  | { readonly _tag: "HalfOpen" };

export type BreakerOptions = { readonly threshold: number; readonly cooldownMs: number; readonly clock: Cap.Clock };
export type CircuitOpen = { readonly _tag: "CircuitOpen"; readonly until: number };

export const circuitBreaker = (opts: BreakerOptions) => {
  let state: State = { _tag: "Closed", failures: 0 }; // the breaker owns this state; callers see only a function
  return async <E, A>(run: () => AsyncResult<E, A>): AsyncResult<E | CircuitOpen, A> => {
    const now = opts.clock.now();
    if (state._tag === "Open") {
      if (now < state.until) return err({ _tag: "CircuitOpen", until: state.until });
      state = { _tag: "HalfOpen" };
    }
    const r = await run();
    if (r.ok) {
      state = { _tag: "Closed", failures: 0 };
      return r;
    }
    const failures = state._tag === "Closed" ? state.failures + 1 : opts.threshold;
    state = failures >= opts.threshold ? { _tag: "Open", until: now + opts.cooldownMs } : { _tag: "Closed", failures };
    return r;
  };
};
```

Wrap the port in `infra/`: `charge: breaker(() => gateway.charge(...))`. `CircuitOpen` is an ordinary error on the track; the edge maps it to 503 with a `Retry-After`.

## Composition root, config, shutdown

`main.ts` is the only file that reads `process.env`, opens resources, or installs signal handlers. Config is decoded once with `D.struct` into a typed value; secrets are the `Redacted` brand (`boundaries.md`), strings at runtime that never reach a log line (decode issues report paths and expectations, never the offending value of a secret). Shutdown is an `AbortController` tied to `SIGTERM`/`SIGINT` whose signal flows into every in-flight request; resources register disposers as they open and are closed in reverse.

```ts
// main.ts — the one composition root: config decoded once, resources opened once, shutdown in reverse.
import { Cap, D, R, type Infer } from "two-track";
import { jsonLogger } from "./infra/logger.ts";

// Secrets are a brand whose only producer is this decoder (boundaries.md); a decode issue carries a path, never the value.
const Redacted = D.brand(D.nonEmptyString, "Redacted");

const Config = D.struct({
  PORT: D.map(D.pattern(/^\d{2,5}$/, "expected port"), Number),
  DATABASE_URL: Redacted,
  PAYMENTS_API_KEY: Redacted, // secret: never logged, never echoed in errors
  LOG_LEVEL: D.optional(D.literal("info", "warn", "error")),
});
type Config = Infer<typeof Config>;

type Disposer = () => Promise<void>;

const main = async (): Promise<number> => {
  const clock = Cap.systemClock;
  const log = jsonLogger(clock, { service: "orders" });

  const config = R.mapErr(Config.decode(process.env), (e) => D.formatIssues(e));
  if (!config.ok) {
    log.error("config.invalid", { issues: config.error }); // paths only; values of secrets are never in issues
    return 2;
  }
  const cfg: Config = config.value;

  // Resources register a disposer as they open; shutdown runs them in reverse.
  const disposers: Disposer[] = [];
  const shutdown = new AbortController();
  const stop = (): void => shutdown.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  // pretend-open a pool and a server (real adapters live in infra/)
  disposers.push(async () => log.info("db.closed"));
  disposers.push(async () => log.info("server.closed", { port: cfg.PORT }));
  log.info("server.started", { port: cfg.PORT, logLevel: cfg.LOG_LEVEL ?? "info" });

  // Drain: the signal is passed to every in-flight request; the server stops accepting; then dispose in reverse.
  await new Promise<void>((resolve) => shutdown.signal.addEventListener("abort", () => resolve(), { once: true }));
  log.info("shutdown.begin");
  for (let i = disposers.length - 1; i >= 0; i--) await (disposers[i] as Disposer)();
  log.info("shutdown.done");
  return 0;
};

export const run = main;
```

Health and readiness: `/healthz` returns 200 if the process is up; `/readyz` runs a cheap `select 1` through the pool and the breaker states, returning 503 while draining so the load balancer stops routing before the server closes.

## Metrics

A `Metrics` port with `counter` and `histogram`; the adapter decides the wire format. The text exposition format needs no client library:

```ts
// infra/metrics-prometheus.ts — a Metrics adapter that renders the text exposition format. ~25 lines, zero deps.
import type { LogFields, Metrics } from "../domain/ports.ts";

const key = (name: string, labels?: LogFields): string =>
  labels === undefined ? name : `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${String(v)}"`).join(",")}}`;

export const prometheusMetrics = (): Metrics & { readonly render: () => string } => {
  const counters = new Map<string, number>();
  const sums = new Map<string, { count: number; sum: number }>();
  return {
    counter: (name, labels) => void counters.set(key(name, labels), (counters.get(key(name, labels)) ?? 0) + 1),
    histogram: (name, valueMs, labels) => {
      const k = key(name, labels);
      const cur = sums.get(k) ?? { count: 0, sum: 0 };
      sums.set(k, { count: cur.count + 1, sum: cur.sum + valueMs });
    },
    render: () =>
      [
        ...[...counters].map(([k, v]) => `${k} ${v}`),
        ...[...sums].flatMap(([k, s]) => [`${k.replace(/(\{|$)/, "_count$1")} ${s.count}`, `${k.replace(/(\{|$)/, "_sum$1")} ${s.sum}`]),
      ].join("\n"),
  };
};
```

Instrument at the edge: one histogram per route (`http_request_ms{route,status}`), one counter per error tag, one histogram per external dependency call. An OpenTelemetry adapter is the same interface pointed at an OTLP exporter when the platform wants traces too.

## Container and supply chain

```dockerfile
# build
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm check && pnpm build && pnpm prune --prod

# run — zero runtime deps means node_modules is just two-track
FROM gcr.io/distroless/nodejs24-debian12
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
USER nonroot
ENV NODE_ENV=production
CMD ["dist/main.js"]
```

- `pnpm install --frozen-lockfile` in CI and images; `pnpm audit --prod` in CI (with zero runtime dependencies beyond `two-track`, the production audit surface is one package).
- Pin `two-track` to an exact version; upgrade deliberately with the changelog open.
- Run as non-root; distroless or alpine; no shell in the final image; `NODE_OPTIONS=--max-old-space-size` set from the container's memory limit.
- Build artefacts are `dist/` from `tsc -p tsconfig.build.json`; no bundler is needed, and scripts never run `.ts` in production.

## Definition of done

- [ ] Structured JSON logs via the `Logger` port; zero `console.*` in `src/`; `requestId` on every line; error tags as fields; no secrets logged
- [ ] One edge per transport maps every error tag to a status with `match` (exhaustive) and emits the metric
- [ ] Every external call has `Async.withTimeout`, threads its signal into the client, and retries only on a `retriable` field with jittered `Async.backoff`
- [ ] Every fan-out is `Async.mapConcurrent` with `concurrency` sized to the downstream; retried writes carry idempotency keys
- [ ] Flaky dependencies sit behind the circuit breaker; `CircuitOpen` maps to 503 + `Retry-After`
- [ ] `main.ts` is the only composition root: config decoded once with `D.struct`, resources opened once, disposers run in reverse on `SIGTERM`
- [ ] `/healthz` and `/readyz` exist; readiness fails while draining
- [ ] `Metrics` port instrumented per route, per error tag, per dependency
- [ ] Multi-stage image, non-root, frozen lockfile, `pnpm audit --prod` in CI, `two-track` pinned exactly
- [ ] `pnpm check` green and its output pasted in the hand-off
