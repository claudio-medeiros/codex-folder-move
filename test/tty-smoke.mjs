#!/usr/bin/env node
/*
  Real-terminal (PTY) smoke test for codex-folder-move.mjs.

  Uses expect(1) — shipped with macOS — to run the tool inside a genuine
  pseudo-terminal: readline in terminal mode, raw keystrokes, echo, prompts
  answered only after they actually appear. Complements run-tests.mjs, whose
  interactive tests drive piped (non-TTY) stdin.

  Flow: build fixture → snapshot → PTY migrate session → verify migrated
  state → PTY restore session → verify byte-identical to snapshot.

  Run: node test/tty-smoke.mjs   (optional env CODEX_FOLDER_MOVE_TEST_TMP=<dir>)
*/

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(TEST_DIR, "..", "codex-folder-move.mjs");

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function normalizeSqlite(codexHome) {
  const db = path.join(codexHome, "state_5.sqlite");
  execFileSync("sqlite3", [db, "PRAGMA wal_checkpoint(TRUNCATE);"]);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(db + suffix)) fs.rmSync(db + suffix);
  }
}

function snapshot(codexHome) {
  normalizeSqlite(codexHome);
  const out = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(path.relative(codexHome, full), sha256(full));
    }
  };
  walk(codexHome);
  return out;
}

if (spawnSync("expect", ["-v"], { encoding: "utf8" }).status !== 0) {
  fail("expect(1) not found — it ships with macOS; install it to run the PTY test");
}

console.log("Building fixture...");
const made = spawnSync(process.execPath, [path.join(TEST_DIR, "run-tests.mjs"), "--make-fixture"], {
  encoding: "utf8",
  env: process.env,
});
if (made.status !== 0) fail(`fixture build failed: ${made.stderr}`);
const fx = JSON.parse(made.stdout);

const before = snapshot(fx.codexHome);

console.log("PTY session 1: interactive migration (expect drives a real terminal)...");
const migrate = spawnSync("expect", [path.join(TEST_DIR, "tty-migrate.exp"), TOOL, fx.codexHome, fx.backups, fx.origin, fx.dest], {
  encoding: "utf8",
});
process.stdout.write(migrate.stdout);
if (migrate.status !== 0) fail(`PTY migrate session exited ${migrate.status}`);
if (!migrate.stdout.includes("Migration complete.")) fail("no completion message in PTY transcript");

// verify the migration actually landed
const rows = JSON.parse(
  execFileSync("sqlite3", ["-json", path.join(fx.codexHome, "state_5.sqlite"), "select id, cwd, sandbox_policy from threads;"], {
    encoding: "utf8",
  }),
);
const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
if (byId.t1.cwd !== fx.p.appOneNew) fail(`t1 cwd not migrated: ${byId.t1.cwd}`);
if (byId.t1.sandbox_policy !== null) fail("t1 sandbox_policy no longer NULL");
if (byId.t2.cwd !== fx.p.plainWtNew) fail(`t2 nested cwd not migrated: ${byId.t2.cwd}`);
if (byId.t3.cwd !== fx.p.bobNew) fail(`t3 cwd not migrated: ${byId.t3.cwd}`);
const config = fs.readFileSync(path.join(fx.codexHome, "config.toml"), "utf8");
if (!config.includes(`[projects."${fx.p.appOneNew}"]`)) fail("config new block missing");
if (config.includes(`[projects."${fx.p.appOneOld}"]`)) fail("config old block remains");
if (!fs.existsSync(path.join(fx.p.appOneNew, "src", "main.js"))) fail("folder not copied");
if (!fs.existsSync(path.join(fx.p.appOneOld, "README.md"))) fail("SOURCE FOLDER WAS TOUCHED");
console.log("Migrated state verified (sqlite, config, folder copy, source intact).");

console.log("\nPTY session 2: interactive restore from backup...");
const restore = spawnSync("expect", [path.join(TEST_DIR, "tty-restore.exp"), TOOL, fx.codexHome, fx.backups], {
  encoding: "utf8",
});
process.stdout.write(restore.stdout);
if (restore.status !== 0) fail(`PTY restore session exited ${restore.status}`);

const after = snapshot(fx.codexHome);
for (const [rel, sha] of before) {
  if (!after.has(rel)) fail(`file missing after restore: ${rel}`);
  if (after.get(rel) !== sha) fail(`bytes differ after restore: ${rel}`);
}
for (const rel of after.keys()) {
  if (!before.has(rel)) fail(`unexpected new file after restore: ${rel}`);
}

console.log(`\nPASS  real-PTY migrate + restore, ${before.size} files byte-identical after restore`);
console.log(`Fixture kept under: ${fx.work}`);
