# Project Scaffold — and the Mechanical Enforcement Layer

Everything here exists so the SKILL.md hard rules **fail the build** rather than rely on discipline; a rule with no enforcer rots. The philosophy is Wlaschin's *functional core, imperative shell* laid out as directories whose dependency direction a 60-line script checks on every run. The toolchain is deliberately small: TypeScript 7 does the type-level enforcement, a custom invariants script does architecture and taste, vitest + fast-check do the proving.

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
    "lint": "node scripts/invariants.ts",
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
    "typescript": "^7.0.2",
    "vitest": "^5.0.3"
  }
}
```

Node ≥ 22.18 runs `.ts` files directly through native type stripping, so `scripts/`, `bench/`, and `src/main.ts` need no `tsx`. The price is `erasableSyntaxOnly`: no `enum`, no `namespace`, no parameter properties — none of which this skill uses anyway.

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
scripts/invariants.ts   test/   bench/
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

## 4. scripts/invariants.ts — the rules, with the fix in every message

Copy this file. It is the enforcer for the hard rules the type checker cannot see. Every violation message ends with `— fix: …` because the reader is usually an agent that will apply it without further context. Extend `RULES` when the team adopts a new rule; never widen a rule to make a build pass without a sentence in the commit explaining why.

```ts
// scripts/invariants.ts — copy into the app; run with `node scripts/invariants.ts` (Node ≥ 22.18 strips types).
// Every message ends with the fix, because the reader is usually an agent.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Rule = { readonly id: string; readonly pattern: RegExp; readonly only?: RegExp; readonly fix: string };

const RULES: ReadonlyArray<Rule> = [
  { id: "no-throw", pattern: /\bthrow\b/, fix: "return err(Tagged({...})); throw is for assertNever only" },
  { id: "no-try", pattern: /\btry\s*\{/, only: /^src\/(domain|workflows)\//, fix: "wrap with R.fromThrowable / Async.tryPromise in infra/" },
  { id: "no-catch", pattern: /\.catch\(/, fix: "use Async.fromPromise(promise, onReject); a railway promise never rejects" },
  { id: "no-any", pattern: /:\s*any\b|\bas any\b/, fix: "use unknown and a decoder" },
  { id: "no-generators", pattern: /function\s*\*|\byield\b/, fix: "early return or await (40-80x measured)" },
  { id: "no-freeze", pattern: /Object\.freeze/, fix: "readonly types (10-20x measured)" },
  { id: "no-class-data", pattern: /\bclass\s+[A-Z]/, fix: "plain readonly object types + functions" },
  { id: "no-cast-brand", pattern: /as Brand<|as unknown as/, fix: "obtain brands from a decoder (D.brand)" },
  { id: "no-null-domain", pattern: /\bnull\b/, only: /^src\/domain\//, fix: "Option<A>; null only in infra decoders" },
  { id: "no-platform-core", pattern: /Date\.now\(|new Date\(\)|Math\.random\(|randomUUID\(|setTimeout\(|\bfetch\(/, only: /^src\/(domain|workflows)\//, fix: "take a capability from deps" },
  { id: "domain-imports", pattern: /from\s+["'](?!two-track["']|\.\/|\.\.\/)/, only: /^src\/domain\//, fix: "domain/ imports only two-track and siblings" },
  { id: "workflows-imports", pattern: /from\s+["'][^"']*\/infra\//, only: /^src\/workflows\//, fix: "workflows depend on ports, never on infra/" },
  { id: "one-root", pattern: /process\.env/, only: /^src\/(?!main\.ts)/, fix: "decode env once in main.ts and pass Config down" },
];

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
};

export const check = (root: string): string[] => {
  const out: string[] = [];
  for (const file of walk(join(root, "src"))) {
    const name = relative(root, file);
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const r of RULES) {
        if (r.only !== undefined && !r.only.test(name)) continue;
        if (r.pattern.test(line)) out.push(`${name}:${i + 1}: [${r.id}] ${line.trim()} — fix: ${r.fix}`);
      }
    });
  }
  return out;
};

const violations = check(process.cwd());
if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("invariants: ok");
```

Allowlist by file when a rule has a sanctioned exception (the `money.ts` re-brand helpers for `no-cast-brand`; `assertNever` call sites are fine because the rule matches `throw`, not the call). Also run it as a structural test — `test/architecture.test.ts` calling `check(root)` and expecting `[]` — so `pnpm test` alone catches drift.

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

`typescript-eslint` does not load against the TypeScript 7.0 native compiler, and running a second TypeScript 6 install beside it was judged not worth the complexity (two-track decision 0007). The type checker with every strict flag plus the invariants script covers every hard rule in SKILL.md. When typescript-eslint supports TS ≥ 7.1, add it with `strictTypeChecked` and exactly these extra rules, which are the ones the invariants script cannot express: `@typescript-eslint/switch-exhaustiveness-check` (with `considerDefaultExhaustiveForUnions: false`), `@typescript-eslint/no-floating-promises`, `no-param-reassign`, `prefer-const`. Until then, "every `AsyncResult` is awaited or returned" is a self-review item.

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
      - run: pnpm lint                       # scripts/invariants.ts — fails with the fix in the message
      - run: pnpm vitest run --coverage      # thresholds enforced
      - run: pnpm build
```

Keep the same `pnpm check` locally as the definition of done; CI runs nothing a developer or agent cannot run in one command.

## Checklist

- [ ] `two-track` is the only runtime dependency reachable from `domain/` and `workflows/`; no lodash/Ramda/fp-ts/neverthrow/Zod anywhere
- [ ] tsconfig has `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `erasableSyntaxOnly`, `.ts` imports
- [ ] Layout is `domain/ workflows/ infra/ lib/ <edge>/ main.ts`; `workflows/` never imports `infra/`
- [ ] `scripts/invariants.ts` is present, run by `pnpm lint` and by a structural test; every message ends with `— fix:`
- [ ] `process.env` is read only in `main.ts`; one composition root builds `deps`
- [ ] vitest coverage thresholds set; fast-check installed; no mocking library
- [ ] CI runs typecheck, invariants, tests with coverage, build — the same as `pnpm check`
- [ ] No ESLint config present until typescript-eslint supports the project's TypeScript; the four rules to add then are noted
