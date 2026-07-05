#!/usr/bin/env node
/*
  Fixture-based test suite for codex-folder-move.mjs.

  Builds fake CODEX_HOMEs inside a temp directory and runs the tool against
  them via --codex-home / --backup-dir. It NEVER touches the real ~/.codex.

  Covers the hard gates: injected mid-apply failures with byte-identical
  sha256 restore, paths with spaces/apostrophes, NULL sandbox policies,
  corrupt jsonl lines, collisions, destination block already in config,
  nested worktree cwds, archived sessions, WAL-stray-safe restore.

  Run: node test/run-tests.mjs   (optional env CODEX_FOLDER_MOVE_TEST_TMP=<dir>)
*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "codex-folder-move.mjs");
const TEST_ROOT = process.env.CODEX_FOLDER_MOVE_TEST_TMP
  ? fs.mkdtempSync(path.join(process.env.CODEX_FOLDER_MOVE_TEST_TMP, "codex-folder-move-tests-"))
  : fs.mkdtempSync(path.join(os.tmpdir(), "codex-folder-move-tests-"));

let fixtureCounter = 0;
const results = [];

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeFixture() {
  fixtureCounter += 1;
  const work = path.join(TEST_ROOT, `fixture-${fixtureCounter}`);
  const origin = path.join(work, "origin");
  const dest = path.join(work, "dest");
  const codexHome = path.join(work, "codex-home");
  const backups = path.join(work, "backups");

  const p = {
    appOneOld: path.join(origin, "App One"),
    appOneNew: path.join(dest, "App One"),
    bobOld: path.join(origin, "Bob's App"),
    bobNew: path.join(dest, "Bob's App"),
    plainOld: path.join(origin, "plain"),
    plainNew: path.join(dest, "plain"),
    plainWtOld: path.join(origin, "plain", "worktrees", "wt1"),
    plainWtNew: path.join(dest, "plain", "worktrees", "wt1"),
    collideOld: path.join(origin, "collide"),
    collideNew: path.join(dest, "collide"),
  };

  // physical folders: Bob's App already moved (dest only); collide exists on both sides
  fs.mkdirSync(path.join(p.appOneOld, "src"), { recursive: true });
  fs.writeFileSync(path.join(p.appOneOld, "README.md"), "app one\n");
  fs.writeFileSync(path.join(p.appOneOld, "src", "main.js"), "console.log(1);\n");
  fs.symlinkSync("README.md", path.join(p.appOneOld, "link"));
  fs.mkdirSync(p.plainWtOld, { recursive: true });
  fs.writeFileSync(path.join(p.plainOld, "a.txt"), "plain\n");
  fs.writeFileSync(path.join(p.plainWtOld, "wt.txt"), "worktree\n");
  fs.mkdirSync(p.collideOld, { recursive: true });
  fs.writeFileSync(path.join(p.collideOld, "c.txt"), "collide\n");
  fs.mkdirSync(path.join(origin, "no-meta-folder"), { recursive: true });
  fs.writeFileSync(path.join(origin, "no-meta-folder", "x.txt"), "x\n");
  fs.mkdirSync(p.bobNew, { recursive: true });
  fs.writeFileSync(path.join(p.bobNew, "bob.txt"), "bob\n");
  fs.mkdirSync(p.collideNew, { recursive: true });
  fs.writeFileSync(path.join(p.collideNew, "c2.txt"), "collide dest\n");
  fs.mkdirSync(backups, { recursive: true });

  // config.toml — Bob's destination block already exists; unrelated block has
  // brackets inside an inline array (the case that broke regex-based patching)
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    `[projects."${p.appOneOld}"]
trust_level = "trusted"

[projects."${p.bobOld}"]
trust_level = "trusted"

[projects."${p.bobNew}"]
trust_level = "trusted"

[projects."${p.plainOld}"]
trust_level = "trusted"

[projects."/somewhere/unrelated"]
trust_level = "trusted"
exclude = ["a[b]", "[weird]"]

[projects."${p.collideOld}"]
trust_level = "trusted"

[projects."${p.collideNew}"]
trust_level = "trusted"
`,
  );

  const globalState = {
    "electron-saved-workspace-roots": [p.appOneOld, "/somewhere/unrelated"],
    "active-workspace-roots": [p.plainOld],
    "project-order": [p.appOneOld, p.bobOld, p.plainOld],
    "thread-writable-roots": { t1: [p.appOneOld, p.plainWtOld] },
    "thread-workspace-root-hints": { t2: p.appOneOld },
    "thread-projectless-output-directories": { t3: path.join(p.plainOld, "outputs", "x") },
    "electron-persisted-atom-state": {
      [`sidebar-project-expanded-v1-codex:${p.appOneOld}`]: true,
      [`sidebar-project-expanded-v1-codex:${p.bobOld}`]: false,
      "heartbeat-thread-permissions-by-id": {
        t9: { sandboxPolicy: { writableRoots: [path.join(p.appOneOld, "sub"), "/unrelated"] } },
      },
      "prompt-history": { global: [`check ${p.appOneOld} please`] },
    },
  };
  fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), JSON.stringify(globalState));

  const sandboxWt = JSON.stringify({
    file_system: { entries: [{ path: { path: p.plainWtOld }, access: "rw" }] },
    writable_roots: [p.plainOld],
  });
  const sandboxBob = JSON.stringify({
    file_system: { entries: [{ path: { path: p.bobOld }, access: "rw" }] },
  });
  const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
  execFileSync("sqlite3", [
    path.join(codexHome, "state_5.sqlite"),
    `PRAGMA journal_mode=WAL;
create table threads (id text primary key, cwd text, sandbox_policy text);
insert into threads values ('t1', ${q(p.appOneOld)}, NULL);
insert into threads values ('t2', ${q(p.plainWtOld)}, ${q(sandboxWt)});
insert into threads values ('t3', ${q(p.bobOld)}, ${q(sandboxBob)});
insert into threads values ('t4', '/elsewhere/unrelated', NULL);
insert into threads values ('t5', ${q(p.collideNew)}, NULL);
insert into threads values ('t6', ${q(p.collideOld)}, NULL);`,
  ]);

  const sessionsDir = path.join(codexHome, "sessions", "2026", "06");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "rollout-a.jsonl"),
    [
      JSON.stringify({ type: "session_meta", payload: { cwd: p.appOneOld, id: "a" } }),
      JSON.stringify({
        type: "turn_context",
        payload: {
          cwd: p.appOneOld,
          workspace_roots: [p.appOneOld],
          permission_profile: { file_system: { entries: [{ path: { path: path.join(p.appOneOld, "sub") }, access: "rw" }] } },
          file_system_sandbox_policy: { entries: [{ path: { path: p.appOneOld } }] },
          sandbox_policy: { writable_roots: [p.appOneOld] },
        },
      }),
      JSON.stringify({ type: "message", content: `free text mentioning ${p.appOneOld}` }),
    ].join("\n") + "\n",
  );
  const corruptLine = `{"type":"turn_context","payload":{"cwd":"${p.plainOld}/broken`;
  fs.writeFileSync(
    path.join(sessionsDir, "rollout-plain.jsonl"),
    [
      JSON.stringify({ type: "session_meta", payload: { cwd: p.plainOld } }),
      corruptLine,
      JSON.stringify({ type: "turn_context", payload: { cwd: p.plainWtOld } }),
    ].join("\n") + "\n",
  );
  const archivedDir = path.join(codexHome, "archived_sessions", "2026", "05");
  fs.mkdirSync(archivedDir, { recursive: true });
  fs.writeFileSync(
    path.join(archivedDir, "rollout-bob.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { cwd: p.bobOld } }) + "\n",
  );

  const ambientDir = path.join(codexHome, "ambient-suggestions", "abc123");
  fs.mkdirSync(ambientDir, { recursive: true });
  fs.writeFileSync(
    path.join(ambientDir, "ambient-suggestions.json"),
    JSON.stringify({ projectRoot: p.appOneOld, suggestions: [] }),
  );

  return { work, origin, dest, codexHome, backups, p, corruptLine };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runTool(fixture, args, options = {}) {
  return spawnSync(
    process.execPath,
    [TOOL, "--codex-home", fixture.codexHome, "--backup-dir", fixture.backups, ...args],
    { encoding: "utf8", input: options.input, env: { ...process.env, ...options.env } },
  );
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// The sqlite3 CLI leaves -wal/-shm files with volatile bytes even after
// read-only access. Checkpoint and drop them before snapshotting so tree
// comparisons assert on real database content, not shared-memory noise.
function normalizeSqlite(fixture) {
  const db = path.join(fixture.codexHome, "state_5.sqlite");
  if (!fs.existsSync(db)) return;
  execFileSync("sqlite3", [db, "PRAGMA wal_checkpoint(TRUNCATE);"]);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(db + suffix)) fs.rmSync(db + suffix);
  }
}

function snapshot(fixture) {
  normalizeSqlite(fixture);
  return treeSha(fixture.codexHome);
}

function treeSha(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(path.relative(dir, full), sha256(full));
    }
  };
  walk(dir);
  return out;
}

function assertTreesEqual(before, after, label) {
  for (const [rel, sha] of before) {
    assert(after.has(rel), `${label}: file missing after: ${rel}`);
    assert(after.get(rel) === sha, `${label}: bytes differ: ${rel}`);
  }
  for (const rel of after.keys()) {
    assert(before.has(rel), `${label}: unexpected new file: ${rel}`);
  }
}

function sqliteRows(fixture, sql) {
  const raw = execFileSync("sqlite3", ["-json", path.join(fixture.codexHome, "state_5.sqlite"), sql], {
    encoding: "utf8",
  });
  return JSON.parse(raw || "[]");
}

function readGlobal(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.codexHome, ".codex-global-state.json"), "utf8"));
}

function readConfig(fixture) {
  return fs.readFileSync(path.join(fixture.codexHome, "config.toml"), "utf8");
}

function onlyBackupDir(fixture) {
  const dirs = fs.readdirSync(fixture.backups).filter((name) => name.startsWith("migration-"));
  assert(dirs.length === 1, `expected exactly one backup, found ${dirs.length}`);
  return path.join(fixture.backups, dirs[0]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL  ${name}`);
    console.log(`      ${String(error?.message || error).split("\n")[0]}`);
  }
}

function applyAllArgs(fx, extra = []) {
  return ["--apply", "--origin", fx.origin, "--dest", fx.dest, "--projects", "App One,Bob's App,plain", "--yes", ...extra];
}

// --make-fixture: build one fixture and print its paths as JSON, running no
// tests — used by the PTY smoke test and handy as a manual playground
if (process.argv.includes("--make-fixture")) {
  const fx = makeFixture();
  console.log(JSON.stringify(fx, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("scan discovers projects grouped by parent", () => {
  const fx = makeFixture();
  const run = runTool(fx, ["--scan", "--json"]);
  assert(run.status === 0, `exit ${run.status}: ${run.stderr}`);
  const groups = JSON.parse(run.stdout);
  const originGroup = groups.find((group) => group.parent === fx.origin);
  assert(originGroup, "origin parent not discovered");
  const appOne = originGroup.projects.find((project) => project.path === fx.p.appOneOld);
  assert(appOne && appOne.threads >= 1 && appOne.config >= 1, "App One counts missing");
  const bob = originGroup.projects.find((project) => project.path === fx.p.bobOld);
  assert(bob && bob.sessionFiles >= 1, "Bob's App archived session not discovered");
});

test("plan blocks collisions and metadata-less folders, allows the rest", () => {
  const fx = makeFixture();
  const run = runTool(fx, ["--plan", "--origin", fx.origin, "--dest", fx.dest, "--json"]);
  assert(run.status === 0, `exit ${run.status}: ${run.stderr}`);
  const { plan, notEligible } = JSON.parse(run.stdout);
  const planned = plan.projects.map((project) => path.basename(project.oldPath)).sort();
  assert(JSON.stringify(planned) === JSON.stringify(["App One", "Bob's App", "plain"]), `planned: ${planned}`);
  const blockedNames = notEligible.map((entry) => path.basename(entry.oldPath)).sort();
  assert(JSON.stringify(blockedNames) === JSON.stringify(["collide", "no-meta-folder"]), `blocked: ${blockedNames}`);
  const collide = notEligible.find((entry) => path.basename(entry.oldPath) === "collide");
  assert(collide.blockers.join(" ").includes("destination"), "collision blocker text missing");
});

test("apply migrates every store correctly (spaces, apostrophes, nesting, NULLs)", () => {
  const fx = makeFixture();
  const run = runTool(fx, applyAllArgs(fx, ["--copy-folders"]));
  assert(run.status === 0, `exit ${run.status}: ${run.stderr}\n${run.stdout}`);
  assert(run.stdout.includes("Migration complete."), "no completion message");

  // config.toml: old blocks gone, new present once, Bob's dedup'd, bracket array intact
  const config = readConfig(fx);
  for (const old of [fx.p.appOneOld, fx.p.bobOld, fx.p.plainOld]) {
    assert(!config.includes(`[projects."${old}"]`), `old config block remains: ${old}`);
  }
  assert(countOccurrences(config, `[projects."${fx.p.appOneNew}"]`) === 1, "App One new block");
  assert(countOccurrences(config, `[projects."${fx.p.bobNew}"]`) === 1, "Bob's new block duplicated or missing");
  assert(countOccurrences(config, `[projects."${fx.p.plainNew}"]`) === 1, "plain new block");
  assert(config.includes(`exclude = ["a[b]", "[weird]"]`), "bracket array corrupted");
  assert(config.includes(`[projects."/somewhere/unrelated"]`), "unrelated block lost");
  assert(config.includes(`[projects."${fx.p.collideOld}"]`), "unselected collide block lost");

  // global state: structured fields patched, prompt-history untouched
  const g = readGlobal(fx);
  assert(g["electron-saved-workspace-roots"].includes(fx.p.appOneNew), "saved roots not patched");
  assert(!g["electron-saved-workspace-roots"].includes(fx.p.appOneOld), "saved roots still old");
  assert(JSON.stringify(g["project-order"]) === JSON.stringify([fx.p.appOneNew, fx.p.bobNew, fx.p.plainNew]), "project-order");
  assert(JSON.stringify(g["thread-writable-roots"].t1) === JSON.stringify([fx.p.appOneNew, fx.p.plainWtNew]), "thread-writable-roots nested prefix");
  assert(g["thread-workspace-root-hints"].t2 === fx.p.appOneNew, "workspace root hints");
  assert(g["thread-projectless-output-directories"].t3 === path.join(fx.p.plainNew, "outputs", "x"), "projectless output dirs");
  const atom = g["electron-persisted-atom-state"];
  assert(atom[`sidebar-project-expanded-v1-codex:${fx.p.appOneNew}`] === true, "sidebar key not renamed");
  assert(!(`sidebar-project-expanded-v1-codex:${fx.p.appOneOld}` in atom), "old sidebar key remains");
  assert(
    JSON.stringify(atom["heartbeat-thread-permissions-by-id"].t9.sandboxPolicy.writableRoots) ===
      JSON.stringify([path.join(fx.p.appOneNew, "sub"), "/unrelated"]),
    "heartbeat writableRoots",
  );
  assert(atom["prompt-history"].global[0] === `check ${fx.p.appOneOld} please`, "prompt-history was modified");

  // sqlite: exact + nested cwd patched, NULL stays NULL, unrelated untouched
  const rows = Object.fromEntries(sqliteRows(fx, "select id, cwd, sandbox_policy from threads;").map((row) => [row.id, row]));
  assert(rows.t1.cwd === fx.p.appOneNew, "t1 cwd");
  assert(rows.t1.sandbox_policy === null, "t1 sandbox_policy must remain NULL");
  assert(rows.t2.cwd === fx.p.plainWtNew, "t2 nested worktree cwd not prefix-migrated");
  const t2sandbox = JSON.parse(rows.t2.sandbox_policy);
  assert(t2sandbox.file_system.entries[0].path.path === fx.p.plainWtNew, "t2 sandbox entry path");
  assert(t2sandbox.writable_roots[0] === fx.p.plainNew, "t2 sandbox writable_roots");
  assert(rows.t3.cwd === fx.p.bobNew, "t3 cwd (apostrophe path)");
  assert(rows.t4.cwd === "/elsewhere/unrelated" && rows.t4.sandbox_policy === null, "t4 must be untouched");
  assert(rows.t6.cwd === fx.p.collideOld, "unselected collide thread must be untouched");

  // sessions: fields patched, free text + corrupt line byte-identical, archived patched
  const sessionA = fs.readFileSync(path.join(fx.codexHome, "sessions", "2026", "06", "rollout-a.jsonl"), "utf8");
  const linesA = sessionA.trim().split("\n").map((line) => JSON.parse(line));
  assert(linesA[0].payload.cwd === fx.p.appOneNew, "session_meta cwd");
  assert(linesA[1].payload.permission_profile.file_system.entries[0].path.path === path.join(fx.p.appOneNew, "sub"), "permission entry");
  assert(linesA[1].payload.sandbox_policy.writable_roots[0] === fx.p.appOneNew, "session writable_roots");
  assert(linesA[2].content === `free text mentioning ${fx.p.appOneOld}`, "message free text must be untouched");
  const sessionPlain = fs.readFileSync(path.join(fx.codexHome, "sessions", "2026", "06", "rollout-plain.jsonl"), "utf8");
  const rawPlainLines = sessionPlain.split("\n");
  assert(rawPlainLines[1] === fx.corruptLine, "corrupt line must be byte-identical");
  assert(JSON.parse(rawPlainLines[0]).payload.cwd === fx.p.plainNew, "plain session_meta");
  assert(JSON.parse(rawPlainLines[2]).payload.cwd === fx.p.plainWtNew, "plain nested turn_context");
  const archived = fs.readFileSync(path.join(fx.codexHome, "archived_sessions", "2026", "05", "rollout-bob.jsonl"), "utf8");
  assert(JSON.parse(archived.trim()).payload.cwd === fx.p.bobNew, "archived session not patched");

  // ambient
  const ambient = JSON.parse(fs.readFileSync(path.join(fx.codexHome, "ambient-suggestions", "abc123", "ambient-suggestions.json"), "utf8"));
  assert(ambient.projectRoot === fx.p.appOneNew, "ambient projectRoot");

  // folder copies: destination populated, SOURCE STILL PRESENT
  assert(fs.existsSync(path.join(fx.p.appOneNew, "src", "main.js")), "App One not copied");
  assert(fs.readlinkSync(path.join(fx.p.appOneNew, "link")) === "README.md", "symlink not copied verbatim");
  assert(fs.existsSync(path.join(fx.p.appOneOld, "README.md")), "SOURCE FOLDER WAS TOUCHED");
  assert(fs.existsSync(path.join(fx.p.plainWtNew, "wt.txt")), "plain worktree not copied");

  // backup manifest checksums are valid
  const backupDir = onlyBackupDir(fx);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8"));
  assert(manifest.files.length >= 6, `backup too small: ${manifest.files.length} files`);
  for (const item of manifest.files) {
    assert(sha256(item.backup) === item.sha256, `backup checksum mismatch: ${item.backup}`);
  }
  assert(fs.existsSync(path.join(backupDir, "rollback.mjs")), "rollback script missing");
});

for (const point of ["after-config", "after-global", "mid-sessions", "after-sqlite", "postflight"]) {
  test(`injected failure ${point}: automatic byte-identical restore`, () => {
    const fx = makeFixture();
    const before = snapshot(fx);
    const run = runTool(fx, applyAllArgs(fx), { env: { CODEX_FOLDER_MOVE_INJECT_FAIL: point } });
    assert(run.status !== 0, "apply should have failed");
    const output = run.stdout + run.stderr;
    assert(output.includes(`Injected test failure at ${point}`), "injected failure not reported");
    assert(output.includes("Automatic restore complete"), "automatic restore not reported");
    assertTreesEqual(before, snapshot(fx), point);
  });
}

test("--restore latest returns Codex home to pre-apply bytes", () => {
  const fx = makeFixture();
  const before = snapshot(fx);
  const applyRun = runTool(fx, applyAllArgs(fx));
  assert(applyRun.status === 0, `apply failed: ${applyRun.stderr}`);
  assert(sha256(path.join(fx.codexHome, "config.toml")) !== before.get("config.toml"), "apply changed nothing?");
  const restoreRun = runTool(fx, ["--restore", "latest"]);
  assert(restoreRun.status === 0, `restore failed: ${restoreRun.stderr}`);
  assertTreesEqual(before, snapshot(fx), "restore-latest");
});

test("standalone rollback.mjs script restores byte-identically", () => {
  const fx = makeFixture();
  const before = snapshot(fx);
  const applyRun = runTool(fx, applyAllArgs(fx));
  assert(applyRun.status === 0, `apply failed: ${applyRun.stderr}`);
  const script = path.join(onlyBackupDir(fx), "rollback.mjs");
  const rollback = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert(rollback.status === 0, `rollback script failed: ${rollback.stderr}`);
  assert(rollback.stdout.includes("Rollback complete"), "no completion message");
  assertTreesEqual(before, snapshot(fx), "standalone-rollback");
});

test("restore neutralizes stray sqlite -wal/-shm junk (WAL replay hazard)", () => {
  const fx = makeFixture();
  const applyRun = runTool(fx, applyAllArgs(fx));
  assert(applyRun.status === 0, `apply failed: ${applyRun.stderr}`);
  const wal = path.join(fx.codexHome, "state_5.sqlite-wal");
  const shm = path.join(fx.codexHome, "state_5.sqlite-shm");
  const junkWal = "junk wal bytes";
  fs.writeFileSync(wal, junkWal);
  fs.writeFileSync(shm, "junk shm bytes");
  const restoreRun = runTool(fx, ["--restore", "latest"]);
  assert(restoreRun.status === 0, `restore failed: ${restoreRun.stderr}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(onlyBackupDir(fx), "manifest.json"), "utf8"));
  const dbEntry = manifest.files.find((item) => item.original.endsWith("state_5.sqlite"));
  assert(sha256(path.join(fx.codexHome, "state_5.sqlite")) === dbEntry.sha256, "sqlite not byte-identical after restore");
  // junk companions must be gone: either deleted (not in backup) or overwritten with backed-up bytes
  for (const [file, junk] of [[wal, junkWal], [shm, "junk shm bytes"]]) {
    if (!fs.existsSync(file)) continue;
    const entry = manifest.files.find((item) => item.original === file);
    assert(entry, `stray ${path.basename(file)} survived restore without being in backup`);
    assert(fs.readFileSync(file, "utf8") !== junk && sha256(file) === entry.sha256, `junk ${path.basename(file)} not replaced`);
  }
});

test("apply refuses collision projects and changes nothing", () => {
  const fx = makeFixture();
  const before = snapshot(fx);
  const run = runTool(fx, ["--apply", "--origin", fx.origin, "--dest", fx.dest, "--projects", "collide", "--yes"]);
  assert(run.status !== 0, "collision apply should fail");
  assert((run.stdout + run.stderr).includes("Not eligible"), "no eligibility error");
  assertTreesEqual(before, snapshot(fx), "collision");
});

test("apply without --yes refuses and changes nothing", () => {
  const fx = makeFixture();
  const before = snapshot(fx);
  const run = runTool(fx, ["--apply", "--origin", fx.origin, "--dest", fx.dest, "--projects", "plain"]);
  assert(run.status !== 0, "should fail without --yes");
  assertTreesEqual(before, snapshot(fx), "no-yes");
});

test("subset migration leaves other projects untouched", () => {
  const fx = makeFixture();
  const run = runTool(fx, ["--apply", "--origin", fx.origin, "--dest", fx.dest, "--projects", "App One", "--yes"]);
  assert(run.status === 0, `apply failed: ${run.stderr}`);
  const rows = Object.fromEntries(sqliteRows(fx, "select id, cwd from threads;").map((row) => [row.id, row]));
  assert(rows.t1.cwd === fx.p.appOneNew, "App One migrated");
  assert(rows.t2.cwd === fx.p.plainWtOld, "plain worktree must be untouched");
  assert(rows.t3.cwd === fx.p.bobOld, "Bob's must be untouched");
  const config = readConfig(fx);
  assert(config.includes(`[projects."${fx.p.plainOld}"]`), "plain config block must remain");
  assert(config.includes(`[projects."${fx.p.bobOld}"]`), "Bob's old config block must remain");
});

test("interactive flow: menus, checklist, confirm, migrate", () => {
  const fx = makeFixture();
  const input = ["1", "c", fx.origin, "c", fx.dest, "a", "d", "y", "migrate", "4", ""].join("\n");
  const run = runTool(fx, [], { input });
  assert(run.status === 0, `exit ${run.status}: ${run.stderr}\n${run.stdout}`);
  assert(run.stdout.includes("Migration complete."), "interactive migration did not complete");
  assert(run.stdout.includes("BLOCKED"), "checklist did not show blocked projects");
  // the nested worktree thread (plain/worktrees/wt1) must not surface as a
  // phantom parent option in the pickers — it migrates with "plain"
  assert(!run.stdout.includes(`${path.join(fx.p.plainOld, "worktrees")}  (`), "nested worktree listed as parent option");
  const config = readConfig(fx);
  assert(config.includes(`[projects."${fx.p.appOneNew}"]`), "config not patched via interactive flow");
  assert(fs.existsSync(path.join(fx.p.appOneNew, "src", "main.js")), "folder not copied via interactive flow");
  assert(fs.existsSync(path.join(fx.p.appOneOld, "README.md")), "SOURCE FOLDER WAS TOUCHED");
});

test("interactive navigation: invalid input, toggles, paging, cancels change nothing", () => {
  const fx = makeFixture();
  const before = snapshot(fx);
  // checklist numbering is sorted by path: 1=App One, 2=Bob's App, 3=collide
  // (blocked), 4=no-meta-folder (blocked), 5=plain
  const input = [
    "9", // invalid main menu choice
    "2", // scan from the menu, then back to the menu
    "1", // migrate
    "zz", // invalid origin choice
    "1", // origin by number (origin parent has the most projects -> listed first)
    "1", // destination by number (dest parent is first once origin is excluded)
    "3", // toggle a blocked project -> refused
    "a", // select all eligible
    "n", // clear selection
    "1,5", // toggle App One + plain via comma list
    "2-2", // toggle Bob's App via range
    "2", // untoggle Bob's App again
    ">", // next page (single page: clamps and re-renders)
    "<", // previous page
    "xyz", // invalid checklist input
    "q", // cancel the checklist
    "1", // migrate again
    "1", // origin by number
    "1", // destination by number
    "1", // select App One
    "d", // done
    "y", // yes, copy folders
    "nope", // decline the final confirmation
    "4", // quit
    "",
  ].join("\n");
  const run = runTool(fx, [], { input });
  assert(run.status === 0, `exit ${run.status}: ${run.stderr}\n${run.stdout}`);
  assert(run.stdout.includes("Invalid choice."), "invalid menu choice not rejected");
  assert(countOccurrences(run.stdout, "Codex projects)") >= 2, "scan-from-menu output missing");
  assert(run.stdout.includes("Cannot select 3"), "blocked project toggle not refused");
  assert(run.stdout.includes("Invalid input."), "invalid checklist input not rejected");
  assert(run.stdout.includes("Nothing selected. Cancelled."), "checklist cancel path missing");
  assert(run.stdout.includes("Cancelled. Nothing was changed."), "confirm decline path missing");
  assert(!run.stdout.includes("Migration complete."), "migration ran despite declined confirm");
  assert(!fs.existsSync(fx.p.appOneNew), "folder copied despite declined confirm");
  assertTreesEqual(before, snapshot(fx), "interactive-navigation");
});

test("interactive selection state: a/n/toggles land on the right projects", () => {
  const fx = makeFixture();
  // select all eligible, untoggle App One and plain -> only Bob's App migrates
  const input = ["1", "1", "1", "a", "1", "5", "d", "migrate", "4", ""].join("\n");
  const run = runTool(fx, [], { input });
  assert(run.status === 0, `exit ${run.status}: ${run.stderr}\n${run.stdout}`);
  assert(run.stdout.includes("Migration complete."), "migration did not complete");
  const rows = Object.fromEntries(sqliteRows(fx, "select id, cwd from threads;").map((row) => [row.id, row]));
  assert(rows.t3.cwd === fx.p.bobNew, "Bob's App should have migrated");
  assert(rows.t1.cwd === fx.p.appOneOld, "App One must be untouched after untoggle");
  assert(rows.t2.cwd === fx.p.plainWtOld, "plain must be untouched after untoggle");
});

test("interactive destination-create prompt makes the parent folder", () => {
  const fx = makeFixture();
  const before = snapshot(fx);
  const newDest = path.join(fx.work, "brand-new-dest");
  const input = ["1", "c", fx.origin, "c", newDest, "y", "q", "4", ""].join("\n");
  const run = runTool(fx, [], { input });
  assert(run.status === 0, `exit ${run.status}: ${run.stderr}\n${run.stdout}`);
  assert(fs.existsSync(newDest), "destination parent was not created");
  assertTreesEqual(before, snapshot(fx), "dest-create-then-cancel");
});

test("interactive restore menu restores the latest backup", () => {
  const fx = makeFixture();
  const before = snapshot(fx);
  const applyRun = runTool(fx, applyAllArgs(fx));
  assert(applyRun.status === 0, `apply failed: ${applyRun.stderr}`);
  const input = ["3", "1", "restore", "4", ""].join("\n");
  const run = runTool(fx, [], { input });
  assert(run.status === 0, `exit ${run.status}: ${run.stderr}\n${run.stdout}`);
  assertTreesEqual(before, snapshot(fx), "interactive-restore");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
if (failed.length) {
  console.log("\nFailures:");
  for (const result of failed) {
    console.log(`- ${result.name}`);
    console.log(String(result.error?.stack || result.error).split("\n").slice(0, 6).join("\n"));
  }
}
console.log(`\nFixtures kept for inspection under: ${TEST_ROOT}`);
process.exit(failed.length ? 1 : 0);
