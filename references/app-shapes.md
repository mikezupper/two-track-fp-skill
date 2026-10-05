# App Shapes: HTTP APIs, CLIs, Libraries, Browser, Edge

The onion is identical in every shape — `domain/` (decoders, types, errors, pure functions), `workflows/` (`(deps, command) => AsyncResult`), `infra/` (adapters implementing the ports), one composition root. Only the outermost adapter changes, and it is always the same three steps: **decode the input, run the workflow, `match` the result into the transport's vocabulary**. Verified against two-track 0.1.0 (October 2026).

## HTTP API

Any router works because the adapter is a function from request to response with no framework types leaking inward. Hono is the default (web-standard `Request`/`Response`, runs on Node, Bun, Deno, and workers unchanged):

```ts
// HTTP API with Hono. The adapter is three steps: decode → workflow → match. No logic in handlers.
// (Hono is stubbed here with the shape of its API; `pnpm add hono` in a real project.)
import { D, R, match, ok, tagged, type AsyncResult, type Infer } from "two-track";

type HonoContext = { readonly req: { json: () => Promise<unknown>; readonly raw: { readonly signal: AbortSignal } }; json: (body: unknown, status: number) => Response };
type HonoApp = { post: (path: string, handler: (c: HonoContext) => Promise<Response>) => HonoApp; get: (path: string, handler: (c: HonoContext) => Promise<Response>) => HonoApp };

// domain/
const Sku = D.brand(D.pattern(/^[A-Z]{3}-\d{3}$/, "expected SKU like ABC-123"), "Sku");
const PlaceOrder = D.struct({ userId: D.nonEmptyString, lines: D.nonEmptyArray(D.struct({ sku: Sku, qty: D.min(D.integer, 1) })) });
type PlaceOrder = Infer<typeof PlaceOrder>;
const InvalidBody = tagged("InvalidBody")<{ issues: string }>();
const OutOfStock = tagged("OutOfStock")<{ sku: Infer<typeof Sku> }>();
type PlaceOrderError = ReturnType<typeof InvalidBody> | ReturnType<typeof OutOfStock>;

// workflows/
type Deps = { readonly stock: { readonly has: (sku: Infer<typeof Sku>, qty: number, signal: AbortSignal) => AsyncResult<never, boolean> } };
const placeOrder = async (deps: Deps, cmd: PlaceOrder, signal: AbortSignal): AsyncResult<ReturnType<typeof OutOfStock>, { readonly orderId: string }> => {
  for (const line of cmd.lines) {
    const has = await deps.stock.has(line.sku, line.qty, signal);
    if (!has.ok) return has;
    if (!has.value) return { ok: false, error: OutOfStock({ sku: line.sku }) };
  }
  return ok({ orderId: `o-${cmd.userId}` });
};

// infra/http.ts — the adapter
export const routes = (app: HonoApp, deps: Deps): HonoApp =>
  app
    .post("/orders", async (c) => {
      const body = R.mapErr(PlaceOrder.decode(await c.req.json()), (e) => InvalidBody({ issues: D.formatIssues(e) }));
      const result: R.Result<PlaceOrderError, { readonly orderId: string }> = body.ok ? await placeOrder(deps, body.value, c.req.raw.signal) : body;
      return R.match(
        result,
        (order) => c.json(order, 201),
        (e) => match(e, { InvalidBody: ({ issues }) => c.json({ error: "invalid_body", issues }, 400), OutOfStock: ({ sku }) => c.json({ error: "out_of_stock", sku }, 409) }),
      );
    })
    .get("/healthz", async (c) => c.json({ ok: true }, 200));
```

| Framework | Body | Abort signal | Response | Notes |
|---|---|---|---|---|
| Hono | `await c.req.json()` | `c.req.raw.signal` | `c.json(body, status)` | same code on every runtime |
| Fastify | `request.body` (disable its schema; decode with `D`) | `request.raw` + `AbortController` on `close` | `reply.code(status).send(body)` | fastest on Node; Node-only |
| `node:http` | collect chunks, then `D.json(Decoder).decode(text)` | `req.once("close")` → `controller.abort()` | `res.writeHead(status).end(JSON.stringify(body))` | zero deps; fine for small services |

Rules: handlers never contain logic; the request's signal is threaded into the workflow and from there into every external call; the error → status table is one `match` per transport (see `production.md`); decode failures are 400 with `D.formatIssues` text; unknown tags are impossible by construction.

## CLI

`node:util`'s `parseArgs` yields strings and booleans; a `D.struct` turns them into the command; exit codes come from an exhaustive `match`, using the sysexits convention (64 usage, 65 data, 66 no input, 69 unavailable, 70 software).

```ts
// CLI: parseArgs gives you strings; D.struct turns them into a command; exit codes come from match.
import { parseArgs } from "node:util";
import { D, R, match, ok, tagged, type AsyncResult, type Infer } from "two-track";

const Command = D.struct({
  input: D.nonEmptyString,
  concurrency: D.map(D.pattern(/^\d{1,3}$/, "expected 1-999"), Number),
  dryRun: D.boolean,
});
type Command = Infer<typeof Command>;

const BadArgs = tagged("BadArgs")<{ issues: string }>();
const InputMissing = tagged("InputMissing")<{ path: string }>();
type CliError = ReturnType<typeof BadArgs> | ReturnType<typeof InputMissing>;

type Deps = { readonly exists: (path: string) => AsyncResult<never, boolean>; readonly stderr: (line: string) => void };

const run = async (deps: Deps, cmd: Command): AsyncResult<ReturnType<typeof InputMissing>, { readonly processed: number }> => {
  const present = await deps.exists(cmd.input);
  if (!present.ok) return present;
  if (!present.value) return { ok: false, error: InputMissing({ path: cmd.input }) };
  return ok({ processed: cmd.dryRun ? 0 : 1 });
};

export const main = async (deps: Deps, argv: ReadonlyArray<string>): Promise<number> => {
  const { values } = parseArgs({ args: [...argv], options: { input: { type: "string" }, concurrency: { type: "string", default: "4" }, "dry-run": { type: "boolean", default: false } } });
  const parsed = R.mapErr(Command.decode({ input: values.input, concurrency: values.concurrency, dryRun: values["dry-run"] }), (e) => BadArgs({ issues: D.formatIssues(e) }));
  const result: R.Result<CliError, { readonly processed: number }> = parsed.ok ? await run(deps, parsed.value) : parsed;
  return R.match(
    result,
    ({ processed }) => (deps.stderr(`processed ${processed}`), 0),
    (e) => match(e, { BadArgs: ({ issues }) => (deps.stderr(`usage: import --input <file> [--concurrency n] [--dry-run]\n${issues}`), 64), InputMissing: ({ path }) => (deps.stderr(`no such file: ${path}`), 66) }),
  );
};
```

`bin/cli.ts`: `process.exit(await main({ exists: realExists, stderr: (l) => process.stderr.write(l + "\n") }, process.argv.slice(2)))`. Node ≥ 22.18 runs the `.ts` directly; ship `dist/` for npm.

## Publishable library

Same `tsconfig` as `two-track` itself (strict flags, `erasableSyntaxOnly`, `verbatimModuleSyntax`), ESM only, and no `node:` imports if it should run in browsers. Errors are tagged types exported alongside the functions; never throw across a package boundary.

```json
{
  "type": "module",
  "sideEffects": false,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "README.md", "LICENSE"],
  "peerDependencies": { "two-track": "^0.1.0" },
  "engines": { "node": ">=22.18" }
}
```

`two-track` is a **peer** dependency for libraries (one copy of the `Result` shape per app; it is structural anyway, but the peer keeps versions aligned) and a regular dependency for applications.

## Browser and Lit frontends

Nothing changes: no `node:` is used anywhere in `two-track`, so the same import works in the browser. Decode every `fetch` response (the server is another untrusted boundary), keep view state as a tagged union rather than `loading`/`error`/`data` flags, and represent "nothing selected" as `Option`. For the component layer itself, use the `lit-web-apps` skill; this skill owns the data and state model under it.

```ts
// Browser / Lit: two-track runs unchanged. Decode every fetch; keep view state as Option / tagged unions.
import { Async, D, O, match, tagged, type AsyncResult, type Infer, type Option } from "two-track";

const Product = D.struct({ id: D.nonEmptyString, name: D.nonEmptyString, priceCents: D.min(D.integer, 0) });
type Product = Infer<typeof Product>;
const Network = tagged("Network")<{ status: number }>();
const BadPayload = tagged("BadPayload")<{ issues: string }>();
type LoadError = ReturnType<typeof Network> | ReturnType<typeof BadPayload>;

// infra/api.ts — the interop edge: fetch may reject or return non-JSON; both become tagged errors.
export const loadProducts = async (signal: AbortSignal): AsyncResult<LoadError, ReadonlyArray<Product>> => {
  const res = await Async.tryPromise((s) => fetch("/api/products", { signal: s }), () => Network({ status: 0 }), signal);
  if (!res.ok) return res;
  if (!res.value.ok) return { ok: false, error: Network({ status: res.value.status }) };
  const text = await Async.tryPromise(() => res.value.text(), () => Network({ status: res.value.status }));
  if (!text.ok) return text;
  const decoded = D.json(D.array(Product)).decode(text.value);
  return decoded.ok ? decoded : { ok: false, error: BadPayload({ issues: D.formatIssues(decoded.error) }) };
};

// view state: a tagged union, never `loading: boolean; error?: string; data?: Product[]`
export type ViewState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failed"; readonly error: LoadError }
  | { readonly _tag: "Loaded"; readonly products: ReadonlyArray<Product>; readonly selected: Option<Product> };

export const title = (s: ViewState): string =>
  match(s, {
    Loading: () => "Loading…",
    Failed: ({ error }) => match(error, { Network: ({ status }) => `Offline (${status})`, BadPayload: () => "Unexpected response" }),
    Loaded: ({ selected }) => O.match(selected, (p) => p.name, () => "Products"),
  });
```

## Edge workers (Cloudflare Workers, Deno Deploy, Vercel Edge)

Web-standard runtime, no `node:`, cold starts measured in milliseconds — exactly where zero runtime dependencies pays. Platform bindings (KV, D1, queues) are the capability implementations; the handler module is the composition root.

```ts
// Edge worker (Cloudflare / Deno Deploy): no `node:`; capabilities come from the platform; the same decode → workflow → match.
import { Async, Cap, D, R, match, ok, tagged, type AsyncResult, type Infer } from "two-track";

const Shorten = D.struct({ url: D.pattern(/^https?:\/\/\S+$/, "expected http(s) URL") });
type Shorten = Infer<typeof Shorten>;
const InvalidBody = tagged("InvalidBody")<{ issues: string }>();
const StoreUnavailable = tagged("StoreUnavailable")<{}>();
type ShortenError = ReturnType<typeof InvalidBody> | ReturnType<typeof StoreUnavailable>;

type KV = { put: (key: string, value: string) => Promise<void> }; // the platform binding
type Deps = { readonly kv: KV; readonly ids: Cap.IdGen };

const shorten = async (deps: Deps, cmd: Shorten): AsyncResult<ReturnType<typeof StoreUnavailable>, { readonly code: string }> => {
  const code = deps.ids.next().slice(0, 8);
  const put = await Async.fromPromise(deps.kv.put(code, cmd.url), () => StoreUnavailable({})); // interop edge
  return put.ok ? ok({ code }) : put;
};

export default {
  async fetch(request: Request, env: { readonly LINKS: KV }): Promise<Response> {
    const deps: Deps = { kv: env.LINKS, ids: Cap.systemIdGen }; // composition root = the handler module
    const raw = await Async.fromPromise(request.json(), () => null); // interop edge: malformed JSON → decode sees null → 400
    const body = R.mapErr(Shorten.decode(raw.ok ? raw.value : null), (e) => InvalidBody({ issues: D.formatIssues(e) }));
    const result: R.Result<ShortenError, { readonly code: string }> = body.ok ? await shorten(deps, body.value) : body;
    return R.match(
      result,
      ({ code }) => Response.json({ code }, { status: 201 }),
      (e) => match(e, { InvalidBody: ({ issues }) => Response.json({ error: issues }, { status: 400 }), StoreUnavailable: () => Response.json({ error: "store" }, { status: 503 }) }),
    );
  },
};
```

## Full-stack monorepo

Share `domain/` between the API and the UI as a workspace package so the decoders are the single contract: the server decodes the request with the same `D.struct` the client used to build it.

```
packages/
├── domain/        two-track only. decoders, types, errors, pure functions. no I/O, no node:, no DOM
├── workflows/     depends on domain. ports + async workflows. no I/O implementations
├── api/           Hono/Fastify adapter + infra (pg, queues) + main.ts composition root
└── ui/            Lit app; imports domain for decoders/types; its own infra/ for fetch adapters
pnpm-workspace.yaml   packages: ["packages/*"]
```

Rules: `domain` and `workflows` have `"dependencies": { "two-track": "…" }` and nothing else; `api` and `ui` depend on them, never on each other; a `test/architecture.test.ts` in the root greps `import` lines to enforce the direction (see `code-review.md` §2).

## Checklist

- [ ] The adapter is decode → workflow → match; no logic in handlers, commands, or components
- [ ] The transport's signal (request abort, SIGTERM, component disconnect) reaches every external call
- [ ] One exhaustive `match` maps error tags to statuses / exit codes / view states per transport
- [ ] Decode failures surface `D.formatIssues` text (400 / exit 64 / "Unexpected response"), never a stack
- [ ] Libraries: ESM, `sideEffects: false`, exports map, `two-track` as a peer, no `node:` if browser-capable, no throws across the boundary
- [ ] Browser/edge code imports nothing from `node:`; platform bindings are the capability implementations
- [ ] Monorepo: `domain`/`workflows` depend only on `two-track`; direction enforced by a structural test
