# Project Scaffold — and the Mechanical Enforcement Layer

Everything here exists so the SKILL.md hard rules **fail the build** rather than rely on discipline; a rule with no enforcer rots. The philosophy is Wlaschin's *functional core, imperative shell* laid out as directories whose dependency direction a 60-line script checks on every run. The toolchain is deliberately small: TypeScript 7 does the type-level enforcement, `two-track-check` (a separate dev-time package with the type-aware rules TypeScript 7 alone cannot express) does architecture and taste, vitest + fast-check + `two-track/testing` do the proving.

Verified against two-track 0.1.0 (October 2026) with TypeScript 7.0.2, vitest 5.0.3, fast-check 4.10.2, Node 24.

## 1. package.json

`two-track` is the only runtime dependency of `domain/` and `workflows/`. Infrastructure adapters may add drivers (`pg`, `undici`, …) and nothing FP-flavoured (no lodash, Ramda, fp-ts, neverthrow, Zod). Until `two-track` is on npm, install it from git.

```jsonc
{
  "name": "my-app",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.18" },
  "packageManager": "pnpm@10.33.2",
  "scripts": {
    "dev": "node --watch src/main.ts",
    "typecheck": "tsc --noEmit",
    "lint": "two-track-check --strict .",
    "test": "vitest run",
    "check": "pnpm typecheck && pnpm lint && pnpm vitest run --coverage",
    "build": "tsc -p tsconfig.build.json"
  },
  "dependencies": {
    "two-track": "github:mikezupper/two-track"      // pin to a tag/commit: "github:mikezupper/two-track#v0.1.0"
  },
  "devDependencies": {
    "@types/node": "^26.6.4",
    "@vitest/coverage-v8": "^5.0.3",
    "fast-check": "^4.10.2",
    "two-track-check": "github:mikezupper/two-track#path:tools/check",   // both move to npm versions once published (release workflow with provenance)
    "typescript": "^7.0.2",
    "vitest": "^5.0.3"
  },
  // Git installs run each package's `prepare` script to build dist/; pnpm 10 requires an explicit allowlist.
  // Drop this block once you install from npm.
  "pnpm": { "onlyBuiltDependencies": ["two-track", "two-track-check"] }
}
```

Node ≥ 22.18 runs `.ts` files directly through native type stripping, so `scripts/`, `bench/`, and `src/main.ts` need no `tsx`. The price is `erasableSyntaxOnly`: no `enum`, no `namespace`, no parameter properties — none of which this skill uses anyway.

## 1b. Import style: subpaths for anything that ships to a browser or an edge runtime

The root entry exposes namespaces (`R`, `O`, `D`, `Async`, `Cap`, `Lane`) and is the readable default for services. Every module is also a subpath (`two-track/result`, `option`, `brand`, `tagged`, `match`, `fn`, `decode`, `async`, `capabilities`, `lanes`, and `two-track/testing`). esbuild retains a whole namespace once any member is touched, so for code that is bundled for a browser or an edge worker import the functions you use from the subpath (two-track decision 0013):

```ts
import { ok, err, andThen } from "two-track/result";
import { struct, integer, nonEmptyString } from "two-track/decode";
import { mapConcurrent } from "two-track/async";
```

Measured on the library's bundle bench: a Result consumer is 117 B through the subpath versus 1,551 B through the root namespace with esbuild; a struct decoder is 1,124 B versus 4,279 B. Rolldown prunes namespaces itself, so there the difference is small. Server code may keep the namespaces; the types are identical either way, and `two-track-check` recognizes both import styles.

## 2. tsconfig.json — strictness is part of the skill

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023", "DOM"],                 // drop DOM for a pure server; keep for browser/edge
    "strict": true,
    "exactOptionalPropertyTypes": true,       // `note?: string` means absent-or-string, never undefined
    "noUncheckedIndexedAccess": true,         // xs[i] is T | undefined — forces the Option/early-return habit
    "noPropertyAccessFromIndexSignature": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "erasableSyntaxOnly": true,               // guarantees Node can strip types without a transpiler
    "allowImportingTsExtensions": true,       // import "./x.ts" — what Node needs
    "rewriteRelativeImportExtensions": true,  // tsc rewrites .ts → .js in the build output
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test", "scripts"]
}
```

TypeScript 7 removed `baseUrl`; use relative imports with `.ts` extensions (or `paths` with `"*": ["./*"]`). A `tsconfig.build.json` extends this with `noEmit: false`, `outDir: "dist"`, `rootDir: "src"`, `include: ["src"]`.

## 3. Layout and dependency direction

```
src/
├── domain/        types, decoders, errors (tagged), pure functions, ports (interfaces). SYNC.
│                  imports: "two-track" and siblings only.
├── workflows/     async (deps, command) => AsyncResult<Error, Outcome>. imports domain/ + lib/.
├── infra/         implementations of the ports: db, http clients, queues, clock adapters.
│                  the ONLY place drivers are imported and try/catch/.catch appear (inside fromThrowable/tryPromise).
├── lib/           tiny project-local helpers (10–150 lines each, tested). no I/O.
├── http/ | cli/   the edge: decode request → workflow → encode response/exit code. imports everything.
└── main.ts        the ONE composition root: decode env, build deps, start, stop.
test/   bench/   two-track-check.json
```

Edges are one-way: `main → http → workflows → domain`, `main → infra → domain`. `workflows/` names ports (interfaces in `domain/ports.ts`) that `infra/` implements; it never imports `infra/`.

```ts
// src/main.ts — the ONE composition root: decode config, build deps, start, stop.
import { Cap, D, type Infer } from "two-track";

const Config = D.struct({
  DATABASE_URL: D.nonEmptyString,
  PORT: D.map(D.optional(D.andThen(D.string, (s) => ({ ok: true, value: Number(s) }))), (p) => p ?? 3000),
});
type Config = Infer<typeof Config>;

type Deps = { readonly clock: Cap.Clock; readonly ids: Cap.IdGen; readonly sleeper: Cap.Sleeper; readonly random: Cap.Random; readonly config: Config };

const buildDeps = (config: Config): Deps => ({ clock: Cap.systemClock, ids: Cap.systemIdGen, sleeper: Cap.systemSleeper, random: Cap.systemRandom, config });

const main = (): number => {
  const config = Config.decode(process.env);
  if (!config.ok) {
    console.error(`config: ${D.formatIssues(config.error)}`);
    return 1;
  }
  const deps = buildDeps(config.value);
  console.log(`starting on :${deps.config.PORT}`);
  return 0;
};

process.exitCode = main();
```

## 4. two-track-check — the rules, with the fix in every message

Do not copy a lint script into the app; a copied script rots. `two-track-check` is versioned with the library (two-track decision 0010) and runs on TypeScript 6's compiler API, which is why it is a separate package with its own dependencies while the app compiles with TypeScript 7. It understands the layout above through a config file:

```json
{
  "layers": {
    "domain": ["src/domain"],
    "workflows": ["src/workflows"],
    "infra": ["src/infra"],
    "lib": ["src/lib"],
    "root": ["src/main.ts"]
  },
  "brandFiles": ["**/decoders.ts", "**/brands.ts", "**/domain/types.ts"],
  "allowedDomainImports": ["two-track"],
  "testFiles": ["**/*.test.ts", "test/**"]
}
```

All keys are optional and merge over these defaults; an `include` array restricts the files checked (useful for a monorepo package). Rule ids are kebab-case so the suppression grammar is uniform.

Save it as `two-track-check.json` at the project root and run `pnpm lint` (`two-track-check --strict .`). What it enforces, each finding ending in `— fix: …`:

| Family | Rules |
|---|---|
| Must-use (type-aware) | `ignored-result` — a `Result` (or an array/promise of Results, e.g. `items.map(fallible);`) used as a statement; `floating-async-result` — an un-awaited promise; `ignored-result-in-callback` — a callback returning a Result where the callee expects `void` (`items.forEach(fallible)`); `floating-async-callback` — `forEach(async …)`. `void expr;` is an explicit, allowed discard |
| Banned constructs | `no-throw`, `no-try`, `no-catch`, `no-generators` (except an `async function*` stream adapter in `infra/`/`lib/`), `no-freeze`, `no-class`, `no-any`, `no-non-null`, `no-ts-suppress`, `no-console` |
| Purity | `no-platform-calls` — `Date.now`, `new Date()`, `Math.random`, `randomUUID`, timers, `fetch` outside `infra/`, `lib/`, `main.ts` |
| Layers | `layer-domain-imports` (domain imports only `two-track` and itself), `layer-workflows-imports` (never `infra/`, `node:`, or drivers) |
| Brands | `no-brand-cast` — `as <BrandedType>` / `as Brand<` / `as unknown as` outside `brandFiles` |
| Concurrency | `no-bare-promise-all`, `fetch-needs-signal`, `switch-default-without-assert-never` |
| Review (non-failing unless `--strict`) | `review-unwrap-or`, `review-decode-unknown` |

Suppress one line with `// two-track-check-allow <rule-id> <reason>`; a suppression without a reason is itself an error, and the summary counts them so a reviewer can see how many exceptions the codebase carries. `--json` emits machine-readable findings for CI annotations.

## 5. vitest config and coverage thresholds

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: { provider: "v8", include: ["src/**/*.ts"], exclude: ["src/main.ts"], thresholds: { lines: 90, branches: 85 } },
  },
});
```

Property tests use `fast-check` directly (`fc.assert(fc.property(...))`); arbitraries live next to the decoders they exercise (`references/testing.md`).

## 6. Why no ESLint (for now)

`typescript-eslint` does not load against the TypeScript 7.0 native compiler (two-track decision 0007). The rules that mattered most from it — exhaustiveness and floating promises — are now covered type-aware by `two-track-check` (`switch-default-without-assert-never`, `floating-async-result`, plus `ignored-result`, which ESLint never had). When typescript-eslint supports TS ≥ 7.1, add it with `strictTypeChecked` for the generic hygiene rules (`no-param-reassign`, `prefer-const`, unused imports); nothing in SKILL.md waits on it.

## 7. CI

```yaml
name: CI
on: { push: { branches: [main] }, pull_request: {} }
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint                       # two-track-check --strict — fails with the fix in the message
      - run: pnpm vitest run --coverage      # thresholds enforced
      - run: pnpm build
```

Keep the same `pnpm check` locally as the definition of done; CI runs nothing a developer or agent cannot run in one command.

## Checklist

- [ ] `two-track` is the only runtime dependency reachable from `domain/` and `workflows/`; no lodash/Ramda/fp-ts/neverthrow/Zod anywhere
- [ ] tsconfig has `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `erasableSyntaxOnly`, `.ts` imports
- [ ] Layout is `domain/ workflows/ infra/ lib/ <edge>/ main.ts`; `workflows/` never imports `infra/`
- [ ] `two-track-check.json` describes the layers; `pnpm lint` runs `two-track-check --strict .`; zero findings or each suppression has a reason
- [ ] `process.env` is read only in `main.ts`; one composition root builds `deps`
- [ ] vitest coverage thresholds set; fast-check installed; no mocking library
- [ ] CI runs typecheck, two-track-check, tests with coverage, build — the same as `pnpm check`
- [ ] No ESLint config present until typescript-eslint supports the project's TypeScript; the four rules to add then are noted
