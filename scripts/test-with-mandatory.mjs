#!/usr/bin/env node
// Storeproject tests need the brAIn workspace alongside (../../brAIn)
// to resolve `@brain/sdk@workspace:*` and friends. This script
// bootstraps that on a fresh checkout (CI) and is a no-op when brAIn
// is already cloned next to this repo (local dev).
//
// Local dev:
//   node scripts/test-with-mandatory.mjs
//   (errors out if ../../brAIn is missing — clone it yourself)
//
// CI:
//   node scripts/test-with-mandatory.mjs --download-mandatory-missing-nodes
//   (auto-clones tibzejoker/brAIn from GitHub if absent)

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const cwd = process.cwd();
const brainPath = resolve(cwd, "..", "..", "brAIn");
const allowDownload = process.argv.includes("--download-mandatory-missing-nodes");

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}${opts.cwd ? `   (in ${opts.cwd})` : ""}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

if (!existsSync(brainPath)) {
  if (!allowDownload) {
    console.error(
      `\nerror: brAIn workspace not found at ${brainPath}\n\n` +
      `Storeproject nodes depend on @brain/sdk via the workspace protocol, so the\n` +
      `brAIn repo must sit alongside this one. Either:\n` +
      `  - clone it: git clone git@github.com:tibzejoker/brAIn.git "${brainPath}"\n` +
      `  - or re-run with --download-mandatory-missing-nodes (used by CI)\n`,
    );
    process.exit(1);
  }
  run(`git clone --depth 1 https://github.com/tibzejoker/brAIn.git "${brainPath}"`);
}

// Full install with lifecycle scripts — brAIn's `onlyBuiltDependencies`
// (better-sqlite3, @lancedb/lancedb*) need their native bindings
// compiled, otherwise storeproject node tests like memory-vector or
// developer fail with "Could not locate the bindings file". The
// postinstall also builds @brain/sdk, @brain/core, @brain/agent and
// clones brAIn-store via HTTPS — all safe in CI.
run("pnpm install --no-frozen-lockfile", { cwd: brainPath });

// Run the storeproject's own tests via its pnpm-workspace.yaml
// (typically `nodes/*`). brAIn's workspace globs `../storeprojects/...`
// so `@brain/sdk@workspace:*` resolved at install-time above and the
// types are available now.
run("pnpm -r --workspace-concurrency=4 --if-present run test");
