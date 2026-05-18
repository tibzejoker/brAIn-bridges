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

// Bootstrap the workspace — skip the heavy postinstall (clones
// brAIn-store, installs the NATS binary, etc.) since storeproject
// unit tests only need types + the build outputs of @brain/sdk and
// @brain/core.
run("pnpm install --no-frozen-lockfile --ignore-scripts", { cwd: brainPath });
run("pnpm --filter @brain/sdk build", { cwd: brainPath });
run("pnpm --filter @brain/core build", { cwd: brainPath });

// Run the storeproject's own tests via its pnpm-workspace.yaml
// (typically `nodes/*`). brAIn's workspace globs `../storeprojects/...`
// so `@brain/sdk@workspace:*` resolves at install-time above and the
// types are available now.
run("pnpm -r --workspace-concurrency=4 --if-present run test");
