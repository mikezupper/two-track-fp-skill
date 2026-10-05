#!/usr/bin/env node
/**
 * Extracts every ```ts block from SKILL.md and references/*.md, lays them out
 * with the illustrative module paths the prose uses, and typechecks them
 * against a local two-track checkout. The test snippets in testing.md are also
 * executed with vitest.
 *
 *   node scripts/verify-snippets.mjs /path/to/two-track
 *
 * Requires that checkout to have run `pnpm install` (TypeScript, vitest and
 * fast-check come from its node_modules). Exits non-zero on any failure.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, symlinkSync, cpSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const lib = process.argv[2];
if (lib === undefined) {
  console.error("usage: node scripts/verify-snippets.mjs /path/to/two-track");
  process.exit(2);
}
const skill = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(tmpdir(), `two-track-skill-snippets-${process.pid}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "src", "domain"), { recursive: true });
mkdirSync(join(out, "domain"), { recursive: true });
symlinkSync(join(lib, "node_modules"), join(out, "node_modules"), "dir");

const blocks = (file) => [...readFileSync(file, "utf8").matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
let count = 0;
for (const md of readdirSync(join(skill, "references")).filter((f) => f.endsWith(".md")).sort()) {
  blocks(join(skill, "references", md)).forEach((b, i) => {
    writeFileSync(join(out, "src", `${basename(md, ".md")}-${String(i).padStart(2, "0")}.ts`), b);
    count++;
  });
}
const canonical = /## Canonical style\n\n```ts\n([\s\S]*?)```/.exec(readFileSync(join(skill, "SKILL.md"), "utf8"));
if (canonical === null) throw new Error("SKILL.md canonical snippet not found");
writeFileSync(join(out, "src", "skill-canonical.ts"), canonical[1]);
count++;

// The prose refers to illustrative modules; each is the snippet that defines those exports.
const aliases = {
  "src/domain-errors.ts": "./railway-00.ts",
  "src/brands.ts": "./domain-types-00.ts",
  "src/time.ts": "./domain-types-06.ts",
  "src/order-state.ts": "./pattern-matching-00.ts",
  "src/errors.ts": "./database-00.ts",
  "src/user-row.ts": "./database-00.ts",
  "src/pool.ts": "./database-01.ts",
  "src/user-repo.ts": "./database-02.ts",
  "src/http.ts": "./concurrency-00.ts",
  "src/ports.ts": "./capabilities-di-00.ts",
  "src/domain/ports.ts": "../capabilities-di-00.ts",
  "src/domain/pricing.ts": "../performance-00.ts",
  "domain/ports.ts": "../src/production-00.ts",
  "domain/arbitraries.ts": "../src/testing-00.ts",
};
for (const [file, target] of Object.entries(aliases)) writeFileSync(join(out, file), `export * from "${target}";\n`);

writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module", private: true }));
writeFileSync(
  join(out, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2023", "DOM"],
      strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, noImplicitOverride: true,
      noPropertyAccessFromIndexSignature: true, verbatimModuleSyntax: true, isolatedModules: true, erasableSyntaxOnly: true,
      allowImportingTsExtensions: true, skipLibCheck: true, noEmit: true, types: ["node"],
      paths: { "two-track": [join(lib, "src/index.ts")], "two-track/testing": [join(lib, "src/testing.ts")] },
    },
    include: ["**/*.ts"],
  }),
);
writeFileSync(
  join(out, "vitest.config.ts"),
  `import { defineConfig } from "vitest/config";
export default defineConfig({ resolve: { alias: [{ find: "two-track/testing", replacement: ${JSON.stringify(join(lib, "src/testing.ts"))} }, { find: "two-track", replacement: ${JSON.stringify(join(lib, "src/index.ts"))} }] }, test: { include: ["src/testing-*.ts"], exclude: ["src/testing-00.ts", "src/testing-08.ts"], root: "." } });
`,
);

const run = (cmd, args) => spawnSync(cmd, args, { cwd: out, stdio: "inherit", shell: process.platform === "win32" });
console.log(`extracted ${count} snippets into ${out}`);
const tsc = run("npx", ["tsc", "-p", "."]);
const vitest = run("npx", ["vitest", "run"]);
const okAll = tsc.status === 0 && vitest.status === 0;
console.log(okAll ? "snippets: ok" : "snippets: FAILED — fix the markdown, not the extracted copy");
if (okAll) rmSync(out, { recursive: true, force: true });
process.exit(okAll ? 0 : 1);
