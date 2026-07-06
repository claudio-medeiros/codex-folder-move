#!/usr/bin/env node
/*
  codex-folder-move — migrate OpenAI Codex desktop-app state when project folders move.

  Design rules:
  - Planning may scan Codex state; apply only touches files listed in the plan.
  - One batch backup (sha256 manifest + standalone rollback script) before any write.
  - Any error during apply/postflight triggers an automatic checksum-verified restore.
  - Folders are only ever COPIED to the destination, never deleted from the source.

  Stores patched (see codex-state-stores):
  - config.toml                  [projects."<path>"] trust blocks
  - .codex-global-state.json     workspace roots, project order, thread-writable-roots,
                                 sidebar keys, heartbeat writableRoots,
                                 thread-workspace-root-hints, thread-projectless-output-directories
  - state_5.sqlite               threads.cwd + threads.sandbox_policy JSON
  - sessions/ + archived_sessions/ *.jsonl   session_meta / turn_context path fields
  - ambient-suggestions/<hash>/ambient-suggestions.json   projectRoot

  Deliberately NOT patched: prompt-history and composer drafts (user-typed free text),
  message content inside session lines (historical text, no functional effect).

  Requirements: Node 18+, sqlite3 CLI, Codex.app closed while applying.
*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

// ---------------------------------------------------------------------------
// Environment & CLI
// ---------------------------------------------------------------------------

const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");
const argv = process.argv.slice(2);

const CODEX_HOME = path.resolve(
  getArgValue("--codex-home") || process.env.CODEX_HOME || DEFAULT_CODEX_HOME,
);
const BACKUP_ROOT = path.resolve(
  getArgValue("--backup-dir") ||
    process.env.CODEX_FOLDER_MOVE_BACKUP_DIR ||
    path.join(os.homedir(), "codex-folder-move-backups"),
);

const FILES = {
  config: path.join(CODEX_HOME, "config.toml"),
  globalState: path.join(CODEX_HOME, ".codex-global-state.json"),
  sqlite: path.join(CODEX_HOME, "state_5.sqlite"),
  sqliteWal: path.join(CODEX_HOME, "state_5.sqlite-wal"),
  sqliteShm: path.join(CODEX_HOME, "state_5.sqlite-shm"),
  sessionRoots: [path.join(CODEX_HOME, "sessions"), path.join(CODEX_HOME, "archived_sessions")],
  ambientRoot: path.join(CODEX_HOME, "ambient-suggestions"),
};

const GLOBAL_ROOT_ARRAY_KEYS = ["electron-saved-workspace-roots", "active-workspace-roots", "project-order"];
const GLOBAL_PATH_MAP_KEYS = ["thread-workspace-root-hints", "thread-projectless-output-directories"];
const SIDEBAR_PREFIX = "sidebar-project-expanded-v1-codex:";

// Rich-TUI module-level state, declared up here (not down by the functions
// that use them) because the whole-app shell now enters the alternate screen
// synchronously at menu-draw time, with no `await` beforehand — so these
// must already be initialized by the time main() runs, not merely hoisted
// like the `function` declarations that use them.
const ESC = "\x1b";
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const CYAN = `${ESC}[36m`;
const GREEN = `${ESC}[32m`;
let richModeActive = false; // only true while the alternate screen is open —
// guards the exit-safety-net below from writing escape codes into
// non-interactive output (e.g. --scan/--plan JSON on a piped stdout).
const MENU_OPTIONS = [
  { key: "1", label: "Migrate projects", action: "migrate" },
  { key: "2", label: "Scan Codex state", action: "scan" },
  { key: "3", label: "Restore from backup", action: "restore" },
  { key: "4", label: "Quit", action: "quit" },
];

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});

async function main() {
  ensureRuntime();

  if (argv.includes("--help") || argv.includes("-h")) return printHelp();
  if (argv.includes("--scan")) return cmdScan();
  if (argv.includes("--plan")) return cmdPlan();
  if (argv.includes("--apply")) return cmdApply();
  if (argv.includes("--restore")) return cmdRestore();

  await interactiveMain();
}

function printHelp() {
  console.log(`codex-folder-move — move Codex desktop-app state when project folders move

Interactive (default):   node codex-folder-move.mjs

Non-interactive:
  --scan [--json]                          discover projects grouped by parent folder
  --plan --origin <dir> --dest <dir> [--projects a,b] [--json]
                                           show the migration plan without changing anything
  --apply --origin <dir> --dest <dir> --projects a,b [--copy-folders] --yes
                                           run the migration (requires --yes)
  --restore [latest|<backup-dir>]          restore a backup (checksum-verified)

Options:
  --codex-home <dir>    Codex state dir (default ~/.codex, or $CODEX_HOME)
  --backup-dir <dir>    where backups go (default ~/codex-folder-move-backups)
  --projects <list>     comma-separated project folder names (or full paths)
  --copy-folders        copy source folders to destination when missing there
  --yes                 skip the confirmation prompt (apply only)
`);
}

function ensureRuntime() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) fail(`Node 18+ required. Current: ${process.version}`);
  try {
    execFileSync("sqlite3", ["--version"], { encoding: "utf8" });
  } catch {
    fail("sqlite3 CLI is required (macOS ships it; try `sqlite3 --version`).");
  }
  if (!fs.existsSync(CODEX_HOME)) fail(`Codex home not found: ${CODEX_HOME}`);
}

// ---------------------------------------------------------------------------
// Path helpers — exact-or-prefix matching is the core fix over the old tools
// ---------------------------------------------------------------------------

function pathMatches(value, base) {
  return typeof value === "string" && (value === base || value.startsWith(base + "/"));
}

function replacePath(value, oldPath, newPath) {
  return pathMatches(value, oldPath) ? newPath + value.slice(oldPath.length) : value;
}

function replacePathAny(value, pairs) {
  for (const pair of pairs) {
    if (pathMatches(value, pair.oldPath)) return pair.newPath + value.slice(pair.oldPath.length);
  }
  return value;
}

function normalizePath(value) {
  let cleaned = String(value || "").trim();
  cleaned = cleaned.replace(/\\ /g, " ");
  while (
    cleaned.length >= 2 &&
    ((cleaned.startsWith("'") && cleaned.endsWith("'")) || (cleaned.startsWith('"') && cleaned.endsWith('"')))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  cleaned = cleaned.replace(/^~(?=$|\/)/, os.homedir());
  const resolved = path.resolve(cleaned);
  return resolved === "/" ? resolved : resolved.replace(/\/+$/, "");
}

function isUsableProjectPath(projectPath) {
  return (
    typeof projectPath === "string" &&
    projectPath.startsWith("/") &&
    projectPath !== "/" &&
    !projectPath.includes("\\") &&
    !projectPath.includes("\0")
  );
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function discoverProjects() {
  const projects = new Map();
  const entryFor = (projectPath) => {
    const key = normalizePath(projectPath);
    if (!projects.has(key)) {
      projects.set(key, {
        path: key,
        basename: path.basename(key),
        counts: { config: 0, global: 0, threads: 0, sessionFiles: new Set(), ambientFiles: new Set() },
      });
    }
    return projects.get(key);
  };

  for (const projectPath of configProjectPaths(safeReadText(FILES.config))) {
    if (isUsableProjectPath(projectPath)) entryFor(projectPath).counts.config += 1;
  }
  // only primary evidence (roots the user actually opened) defines a project;
  // writable-root subpaths and output dirs would create phantom entries
  for (const projectPath of globalStatePaths(safeReadJson(FILES.globalState) || {}, { primaryOnly: true })) {
    if (isUsableProjectPath(projectPath)) entryFor(projectPath).counts.global += 1;
  }
  for (const row of sqliteJson("select cwd, count(*) as count from threads where cwd is not null group by cwd;")) {
    if (isUsableProjectPath(row.cwd)) entryFor(row.cwd).counts.threads += Number(row.count) || 1;
  }
  for (const root of FILES.sessionRoots) {
    for (const file of walkFiles(root, ".jsonl")) {
      for (const projectPath of sessionFilePaths(file)) {
        if (isUsableProjectPath(projectPath)) entryFor(projectPath).counts.sessionFiles.add(file);
      }
    }
  }
  for (const file of walkFiles(FILES.ambientRoot, "ambient-suggestions.json")) {
    const projectRoot = (safeReadJson(file) || {}).projectRoot;
    if (isUsableProjectPath(projectRoot)) entryFor(projectRoot).counts.ambientFiles.add(file);
  }

  return [...projects.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function configProjectPaths(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*\[projects\."(.+)"\]\s*$/);
    if (match) out.push(match[1]);
  }
  return out;
}

function globalStatePaths(json, { primaryOnly = false } = {}) {
  const atom = json["electron-persisted-atom-state"] || {};
  const paths = [];
  for (const key of GLOBAL_ROOT_ARRAY_KEYS) for (const item of json[key] || []) paths.push(item);
  for (const value of Object.values(json["thread-workspace-root-hints"] || {})) paths.push(value);
  for (const key of Object.keys(atom)) {
    if (key.startsWith(SIDEBAR_PREFIX)) paths.push(key.slice(SIDEBAR_PREFIX.length));
  }
  if (primaryOnly) return paths;
  for (const roots of Object.values(json["thread-writable-roots"] || {})) {
    for (const item of roots || []) paths.push(item);
  }
  for (const value of Object.values(json["thread-projectless-output-directories"] || {})) paths.push(value);
  for (const item of Object.values(atom["heartbeat-thread-permissions-by-id"] || {})) {
    for (const root of item?.sandboxPolicy?.writableRoots || []) paths.push(root);
  }
  return paths;
}

function sessionFilePaths(file) {
  const paths = [];
  for (const line of safeReadText(file).split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tolerate corrupt lines everywhere, not just in discovery
    }
    if (obj.type === "session_meta" && obj.payload?.cwd) paths.push(obj.payload.cwd);
    if (obj.type === "turn_context") {
      const payload = obj.payload || {};
      if (payload.cwd) paths.push(payload.cwd);
      for (const root of payload.workspace_roots || []) paths.push(root);
    }
  }
  return paths;
}

// paths nested inside another discovered project (worktrees, subfolders)
// migrate with their parent via prefix matching — they'd only clutter the
// origin/destination pickers as phantom parents
function nonNestedProjects(projects) {
  return projects.filter(
    (project) => !projects.some((other) => other !== project && pathMatches(project.path, other.path)),
  );
}

function groupByParent(projects) {
  const groups = new Map();
  for (const project of projects) {
    const parent = path.dirname(project.path);
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(project);
  }
  return [...groups.entries()]
    .map(([parent, items]) => ({ parent, projects: items }))
    .sort((a, b) => b.projects.length - a.projects.length || a.parent.localeCompare(b.parent));
}

// ---------------------------------------------------------------------------
// Per-project reference counting (prefix-aware) and plan building
// ---------------------------------------------------------------------------

function countProjectRefs(oldPath, newPath) {
  const configText = safeReadText(FILES.config);
  const globalJson = safeReadJson(FILES.globalState) || {};
  const like = sqlLikePrefix(oldPath);
  const sqliteRows = sqliteJson(`
select
  sum(case when cwd=${sqlQuote(oldPath)} or cwd like ${like} then 1 else 0 end) as cwdOld,
  sum(case when cwd=${sqlQuote(newPath)} or cwd like ${sqlLikePrefix(newPath)} then 1 else 0 end) as cwdNew,
  sum(case when sandbox_policy like ${sqlQuote(`%${oldPath}%`)} then 1 else 0 end) as sandboxOld
from threads;`);
  const sqlite = sqliteRows[0] || {};

  const sessionFiles = [];
  for (const root of FILES.sessionRoots) {
    for (const file of walkFiles(root, ".jsonl")) {
      const summary = summarizeSessionFile(file, oldPath);
      if (summary.actionable > 0) sessionFiles.push({ file, actionable: summary.actionable, parseErrors: summary.parseErrors });
    }
  }

  const ambientFiles = [];
  for (const file of walkFiles(FILES.ambientRoot, "ambient-suggestions.json")) {
    const json = safeReadJson(file) || {};
    if (pathMatches(json.projectRoot, oldPath)) ambientFiles.push(file);
  }

  return {
    configBlocksOld: configProjectPaths(configText).filter((p) => pathMatches(p, oldPath)).length,
    configBlocksNew: configProjectPaths(configText).filter((p) => pathMatches(p, newPath)).length,
    globalRefsOld: globalStatePaths(globalJson).filter((p) => pathMatches(p, oldPath)).length,
    sqliteCwdOld: Number(sqlite.cwdOld) || 0,
    sqliteCwdNew: Number(sqlite.cwdNew) || 0,
    sqliteSandboxOld: Number(sqlite.sandboxOld) || 0,
    sessionFiles,
    ambientFiles,
  };
}

function summarizeSessionFile(file, oldPath) {
  let actionable = 0;
  let parseErrors = 0;
  const text = safeReadText(file);
  if (!text.includes(oldPath)) return { actionable: 0, parseErrors: 0 };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    actionable += countSessionObjectRefs(obj, oldPath);
  }
  return { actionable, parseErrors };
}

function countSessionObjectRefs(obj, oldPath) {
  let count = 0;
  if (obj.type === "session_meta" && pathMatches(obj.payload?.cwd, oldPath)) count += 1;
  if (obj.type !== "turn_context") return count;
  const payload = obj.payload || {};
  if (pathMatches(payload.cwd, oldPath)) count += 1;
  for (const value of payload.workspace_roots || []) if (pathMatches(value, oldPath)) count += 1;
  for (const entry of payload.permission_profile?.file_system?.entries || []) {
    if (pathMatches(entry?.path?.path, oldPath)) count += 1;
  }
  for (const entry of payload.file_system_sandbox_policy?.entries || []) {
    if (pathMatches(entry?.path?.path, oldPath)) count += 1;
  }
  for (const value of payload.sandbox_policy?.writable_roots || []) if (pathMatches(value, oldPath)) count += 1;
  return count;
}

function buildProjectEntries(projects, originParent, destinationParent) {
  const byPath = new Map(projects.map((project) => [project.path, project]));
  for (const folder of listImmediateFolders(originParent)) {
    if (!byPath.has(folder)) byPath.set(folder, null); // folder with no Codex metadata
  }

  const entries = [];
  for (const [projectPath, project] of byPath) {
    if (path.dirname(projectPath) !== originParent) continue;
    const oldPath = projectPath;
    const newPath = path.join(destinationParent, path.basename(oldPath));
    const refs = project ? countProjectRefs(oldPath, newPath) : null;
    const hasMetadata = Boolean(
      refs &&
        (refs.configBlocksOld || refs.globalRefsOld || refs.sqliteCwdOld || refs.sqliteSandboxOld ||
          refs.sessionFiles.length || refs.ambientFiles.length),
    );
    const oldExists = fs.existsSync(oldPath);
    const destExists = fs.existsSync(newPath);
    const oldReal = realpathOrNull(oldPath);
    const destReal = realpathOrNull(newPath);
    const samePhysicalFolder = Boolean(oldReal && destReal && oldReal === destReal);
    // a destination project with real history (threads/sessions) is a hard
    // collision; a bare config/global entry is the normal "already re-trusted
    // after moving" state and merges safely (old block dropped, arrays deduped)
    const destProject = projects.find((item) => item.path === newPath && item.path !== oldPath);
    const collision = Boolean(
      destProject &&
        (destProject.counts.threads > 0 || destProject.counts.sessionFiles.size > 0 || destProject.counts.ambientFiles.size > 0),
    );

    const blockers = [];
    if (!hasMetadata) blockers.push("no Codex metadata");
    if (collision) blockers.push("destination path already has its own Codex history (threads/sessions)");
    if (samePhysicalFolder) blockers.push("source and destination are the same folder");
    if (oldPath === newPath) blockers.push("destination equals source");

    const warnings = [];
    if (destProject && !collision) warnings.push("destination already known to Codex; entries will merge");
    let folderAction = "none";
    if (oldExists && !destExists) {
      folderAction = "copy"; // resolved to copy or skip by the user's copy-folders choice
    } else if (!oldExists && destExists) {
      warnings.push("source folder already gone; metadata-only migration");
    } else if (oldExists && destExists) {
      warnings.push("both folders exist; metadata will point at the destination copy");
    } else {
      warnings.push("neither folder exists on disk");
    }

    entries.push({
      oldPath,
      newPath,
      refs,
      hasMetadata,
      oldExists,
      destExists,
      folderAction,
      blockers,
      warnings,
      eligible: blockers.length === 0,
    });
  }
  return entries.sort((a, b) => a.oldPath.localeCompare(b.oldPath));
}

function listImmediateFolders(parent) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((item) => item.isDirectory() && !item.name.startsWith("."))
      .map((item) => normalizePath(path.join(parent, item.name)));
  } catch {
    return [];
  }
}

function buildPlan(originParent, destinationParent, selectedEntries, copyFolders) {
  const pairs = selectedEntries.map((entry) => ({ oldPath: entry.oldPath, newPath: entry.newPath }));
  const touched = new Set([FILES.config, FILES.globalState, FILES.sqlite]);
  if (fs.existsSync(FILES.sqliteWal)) touched.add(FILES.sqliteWal);
  if (fs.existsSync(FILES.sqliteShm)) touched.add(FILES.sqliteShm);
  for (const entry of selectedEntries) {
    for (const item of entry.refs.sessionFiles) touched.add(item.file);
    for (const file of entry.refs.ambientFiles) touched.add(file);
  }
  const folderCopies = copyFolders
    ? selectedEntries
        .filter((entry) => entry.folderAction === "copy")
        .map((entry) => ({ from: entry.oldPath, to: entry.newPath }))
    : [];
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    codexHome: CODEX_HOME,
    originParent,
    destinationParent,
    copyFolders: Boolean(copyFolders),
    projects: selectedEntries.map((entry) => ({
      oldPath: entry.oldPath,
      newPath: entry.newPath,
      folderAction: copyFolders && entry.folderAction === "copy" ? "copy" : "metadata-only",
      warnings: entry.warnings,
      expected: {
        configBlocksOld: entry.refs.configBlocksOld,
        globalRefsOld: entry.refs.globalRefsOld,
        sqliteCwdOld: entry.refs.sqliteCwdOld,
        sqliteSandboxOld: entry.refs.sqliteSandboxOld,
        sessionFiles: entry.refs.sessionFiles.length,
        ambientFiles: entry.refs.ambientFiles.length,
      },
    })),
    pairs,
    folderCopies,
    touchedFiles: [...touched].sort(),
  };
}

// ---------------------------------------------------------------------------
// Apply pipeline: preflight → folder copies → batch backup → patch → postflight
// On any error after the backup exists: automatic checksum-verified restore.
// ---------------------------------------------------------------------------

function applyPlan(plan) {
  preflight(plan);

  for (const copy of plan.folderCopies) copyFolder(copy.from, copy.to);

  sqliteCheckpoint();
  const backup = createBackup(plan);
  console.log(`\nBackup written: ${backup.dir}`);

  try {
    patchConfigFile(plan.pairs);
    injectFail("after-config");
    patchGlobalStateFile(plan.pairs);
    injectFail("after-global");
    patchAmbientFiles(plan);
    injectFail("after-ambient");
    patchSessionFiles(plan);
    injectFail("after-sessions");
    patchSqlite(plan.pairs);
    injectFail("after-sqlite");
    postflight(plan);
  } catch (error) {
    console.error(`\nAPPLY FAILED: ${error?.message || error}`);
    console.error("Starting automatic restore from backup...");
    restoreBackup(backup.dir);
    console.error("Automatic restore complete. Codex state is back to its pre-migration bytes.");
    console.error(`Backup kept at: ${backup.dir}`);
    throw new Error("Migration failed and was rolled back. No changes remain applied.");
  }

  console.log("\nMigration complete.");
  console.log(`Backup: ${backup.dir}`);
  console.log(`Standalone rollback: node ${JSON.stringify(path.join(backup.dir, "rollback.mjs"))}`);
  if (plan.folderCopies.length) {
    console.log("\nCopied folders (sources left untouched — trash them yourself once you're happy):");
    for (const copy of plan.folderCopies) console.log(`  ${copy.from}  ->  ${copy.to}`);
  }
}

function preflight(plan) {
  ensureCodexClosed();
  const integrity = sqliteQuery("pragma integrity_check;").trim();
  if (integrity !== "ok") fail(`SQLite integrity check failed before migration: ${integrity}`);

  for (const project of plan.projects) {
    const refs = countProjectRefs(project.oldPath, project.newPath);
    const expected = project.expected;
    if (refs.sqliteCwdOld < expected.sqliteCwdOld || refs.configBlocksOld < expected.configBlocksOld) {
      fail(`Codex state changed since planning for ${project.oldPath}. Re-run the plan.`);
    }
  }
  for (const file of plan.touchedFiles) {
    if (!fs.existsSync(file) && file !== FILES.sqliteWal && file !== FILES.sqliteShm) {
      fail(`Planned file is missing: ${file}`);
    }
  }
  for (const copy of plan.folderCopies) {
    if (!fs.existsSync(copy.from)) fail(`Folder to copy is missing: ${copy.from}`);
    if (fs.existsSync(copy.to)) fail(`Destination folder appeared since planning: ${copy.to}`);
  }
}

function postflight(plan) {
  injectFail("postflight");
  for (const project of plan.projects) {
    const refs = countProjectRefs(project.oldPath, project.newPath);
    const leftovers = [];
    if (refs.configBlocksOld) leftovers.push(`config blocks=${refs.configBlocksOld}`);
    if (refs.globalRefsOld) leftovers.push(`global refs=${refs.globalRefsOld}`);
    if (refs.sqliteCwdOld) leftovers.push(`sqlite cwd=${refs.sqliteCwdOld}`);
    if (refs.sessionFiles.length) leftovers.push(`session files=${refs.sessionFiles.length}`);
    if (refs.ambientFiles.length) leftovers.push(`ambient files=${refs.ambientFiles.length}`);
    if (refs.sqliteSandboxOld) {
      // sandbox_policy is checked structurally: raw LIKE hits that survive a deep
      // walk are free-text coincidences, not sandbox paths
      const rows = sqliteJson(
        `select sandbox_policy from threads where sandbox_policy like ${sqlQuote(`%${project.oldPath}%`)};`,
      );
      for (const row of rows) {
        let parsed;
        try {
          parsed = JSON.parse(row.sandbox_policy);
        } catch {
          leftovers.push("unparseable sandbox_policy still references old path");
          continue;
        }
        if (jsonContainsPath(parsed, project.oldPath)) leftovers.push("sqlite sandbox_policy");
      }
    }
    if (leftovers.length) {
      throw new Error(`Postflight found old references for ${project.oldPath}: ${leftovers.join(", ")}`);
    }
    if (project.expected.configBlocksOld > 0 && countProjectRefs(project.newPath, project.newPath).configBlocksOld === 0) {
      throw new Error(`Postflight: no config trust block exists for ${project.newPath}`);
    }
    if (refs.sqliteCwdNew < project.expected.sqliteCwdOld) {
      throw new Error(`Postflight: sqlite threads for ${project.newPath} (${refs.sqliteCwdNew}) below expected (${project.expected.sqliteCwdOld})`);
    }
  }
  const integrity = sqliteQuery("pragma integrity_check;").trim();
  if (integrity !== "ok") throw new Error(`SQLite integrity check failed after migration: ${integrity}`);
}

function jsonContainsPath(value, oldPath) {
  if (typeof value === "string") return pathMatches(value, oldPath);
  if (Array.isArray(value)) return value.some((item) => jsonContainsPath(item, oldPath));
  if (value && typeof value === "object") return Object.values(value).some((item) => jsonContainsPath(item, oldPath));
  return false;
}

function injectFail(point) {
  if (process.env.CODEX_FOLDER_MOVE_INJECT_FAIL === point) throw new Error(`Injected test failure at ${point}`);
}

// ---------------------------------------------------------------------------
// Folder copy — copy + verify, never delete the source
// ---------------------------------------------------------------------------

function copyFolder(from, to) {
  console.log(`Copying folder: ${from} -> ${to}`);
  const existedBefore = fs.existsSync(to);
  try {
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    verifyFolderCopy(from, to);
  } catch (error) {
    if (!existedBefore && fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    fail(`Folder copy failed (source untouched, partial copy removed): ${error?.message || error}`);
  }
}

function verifyFolderCopy(from, to) {
  const sourceItems = walkTree(from);
  for (const item of sourceItems) {
    const target = path.join(to, item.rel);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      throw new Error(`copy verification: missing ${target}`);
    }
    if (item.type === "dir" && !stat.isDirectory()) throw new Error(`copy verification: not a directory: ${target}`);
    if (item.type === "file" && (!stat.isFile() || stat.size !== item.size)) {
      throw new Error(`copy verification: size mismatch: ${target}`);
    }
    if (item.type === "link" && fs.readlinkSync(target) !== item.linkTarget) {
      throw new Error(`copy verification: symlink mismatch: ${target}`);
    }
  }
  console.log(`  verified ${sourceItems.filter((item) => item.type === "file").length} files`);
}

function walkTree(root, base = root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const rel = path.relative(base, full);
    if (entry.isSymbolicLink()) {
      out.push({ rel, type: "link", linkTarget: fs.readlinkSync(full) });
    } else if (entry.isDirectory()) {
      out.push({ rel, type: "dir" });
      out.push(...walkTree(full, base));
    } else if (entry.isFile()) {
      out.push({ rel, type: "file", size: fs.lstatSync(full).size });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Backup & restore
// ---------------------------------------------------------------------------

function createBackup(plan) {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(BACKUP_ROOT, `migration-${stamp}`);
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    codexHome: CODEX_HOME,
    plan,
    files: [],
    // sqlite companions that did NOT exist at backup time: restore must delete
    // any that appear later, or SQLite would replay bad WAL over restored bytes
    absentSqliteCompanions: [FILES.sqliteWal, FILES.sqliteShm].filter((file) => !fs.existsSync(file)),
  };

  for (const file of plan.touchedFiles) {
    if (!fs.existsSync(file)) continue;
    const backupPath = path.join(dir, "files", file.replace(/^\//, ""));
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(file, backupPath);
    const sha = fileSha256(backupPath);
    if (sha !== fileSha256(file)) fail(`Backup copy mismatch for ${file}`);
    manifest.files.push({ original: file, backup: backupPath, sha256: sha, bytes: fs.statSync(backupPath).size });
  }

  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeRollbackScript(dir, manifest);
  return { dir, manifest };
}

function restoreBackup(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  // derive backup paths from dir so a moved/renamed backup folder still restores
  const backupPathFor = (item) => path.join(dir, "files", item.original.replace(/^\//, ""));
  for (const item of manifest.files) {
    if (fileSha256(backupPathFor(item)) !== item.sha256) {
      throw new Error(`CRITICAL: backup file corrupted, aborting restore: ${backupPathFor(item)}`);
    }
  }
  for (const item of manifest.files) {
    fs.mkdirSync(path.dirname(item.original), { recursive: true });
    fs.copyFileSync(backupPathFor(item), item.original);
  }
  for (const stray of manifest.absentSqliteCompanions || []) {
    if (fs.existsSync(stray)) fs.rmSync(stray);
  }
  const failures = manifest.files.filter((item) => fileSha256(item.original) !== item.sha256);
  if (failures.length) {
    throw new Error(`CRITICAL: restore verification failed for: ${failures.map((item) => item.original).join(", ")}`);
  }
  console.log(`Restored ${manifest.files.length} file(s), byte-identical to backup.`);
}

function writeRollbackScript(dir, manifest) {
  const script = `#!/usr/bin/env node
// Standalone rollback for the codex-folder-move backup in this directory.
// Verifies backup checksums, restores every file, removes stray SQLite
// -wal/-shm files that did not exist at backup time, then re-verifies.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const dir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const backupPathFor = (item) => path.join(dir, "files", item.original.replace(/^\\//, ""));
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
if (manifest.codexHome === ${JSON.stringify(DEFAULT_CODEX_HOME)}) {
  const ps = execFileSync("ps", ["-axo", "pid=,comm=,args="], { encoding: "utf8" });
  const running = ps.split("\\n").filter((line) => line.includes("/Applications/Codex.app/") || line.includes("Codex Helper"));
  if (running.length) {
    console.error("Close Codex.app before rolling back.");
    process.exit(1);
  }
}
for (const item of manifest.files) {
  if (sha256(backupPathFor(item)) !== item.sha256) {
    console.error("Backup file corrupted, aborting: " + backupPathFor(item));
    process.exit(1);
  }
}
for (const item of manifest.files) {
  fs.mkdirSync(path.dirname(item.original), { recursive: true });
  fs.copyFileSync(backupPathFor(item), item.original);
  console.log("restored " + item.original);
}
for (const stray of manifest.absentSqliteCompanions || []) {
  if (fs.existsSync(stray)) { fs.rmSync(stray); console.log("removed stray " + stray); }
}
const bad = manifest.files.filter((item) => sha256(item.original) !== item.sha256);
if (bad.length) {
  console.error("RESTORE VERIFICATION FAILED for: " + bad.map((item) => item.original).join(", "));
  process.exit(1);
}
console.log("Rollback complete. All files byte-identical to backup.");
`;
  const file = path.join(dir, "rollback.mjs");
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
}

function listBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  return fs
    .readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(BACKUP_ROOT, entry.name, "manifest.json")))
    .map((entry) => {
      const dir = path.join(BACKUP_ROOT, entry.name);
      return { dir, name: entry.name, mtime: fs.statSync(path.join(dir, "manifest.json")).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------------------
// Patchers
// ---------------------------------------------------------------------------

// config.toml — line-based, so brackets inside block bodies can't break parsing
function patchConfigFile(pairs) {
  const text = safeReadText(FILES.config);
  if (!text) return;
  const lines = text.split("\n");
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTomlTableHeader(lines[i])) headers.push(i);
  }
  const blockEnd = (headerIndex) => {
    const position = headers.indexOf(headerIndex);
    return position + 1 < headers.length ? headers[position + 1] : lines.length;
  };

  const existingPaths = new Set(configProjectPaths(text));
  const drop = new Set();
  for (const headerIndex of headers) {
    const match = lines[headerIndex].match(/^\s*\[projects\."(.+)"\]\s*$/);
    if (!match) continue;
    const projectPath = match[1];
    const renamed = replacePathAny(projectPath, pairs);
    if (renamed === projectPath) continue;
    if (existingPaths.has(renamed)) {
      for (let i = headerIndex; i < blockEnd(headerIndex); i++) drop.add(i);
    } else {
      lines[headerIndex] = `[projects."${renamed}"]`;
      existingPaths.add(renamed);
    }
  }
  const result = lines
    .filter((_, index) => !drop.has(index))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  if (result !== text) fs.writeFileSync(FILES.config, result);
}

function isTomlTableHeader(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("[") &&
    /\]\s*(#.*)?$/.test(trimmed) &&
    !trimmed.endsWith(",") &&
    /^\[\[?[^\[\]]/.test(trimmed)
  );
}

function patchGlobalStateFile(pairs) {
  const raw = safeReadText(FILES.globalState);
  const json = safeReadJson(FILES.globalState);
  if (!json) return;
  const before = JSON.stringify(json);
  const swap = (value) => replacePathAny(value, pairs);

  for (const key of GLOBAL_ROOT_ARRAY_KEYS) {
    if (Array.isArray(json[key])) json[key] = dedupe(json[key].map(swap));
  }
  for (const [threadId, roots] of Object.entries(json["thread-writable-roots"] || {})) {
    json["thread-writable-roots"][threadId] = dedupe((roots || []).map(swap));
  }
  for (const key of GLOBAL_PATH_MAP_KEYS) {
    for (const [threadId, value] of Object.entries(json[key] || {})) {
      json[key][threadId] = swap(value);
    }
  }
  const atom = json["electron-persisted-atom-state"] || {};
  for (const key of Object.keys(atom)) {
    if (!key.startsWith(SIDEBAR_PREFIX)) continue;
    const renamed = SIDEBAR_PREFIX + swap(key.slice(SIDEBAR_PREFIX.length));
    if (renamed !== key && !Object.hasOwn(atom, renamed)) {
      atom[renamed] = atom[key];
      delete atom[key];
    } else if (renamed !== key) {
      delete atom[key];
    }
  }
  for (const value of Object.values(atom["heartbeat-thread-permissions-by-id"] || {})) {
    if (Array.isArray(value?.sandboxPolicy?.writableRoots)) {
      value.sandboxPolicy.writableRoots = dedupe(value.sandboxPolicy.writableRoots.map(swap));
    }
  }
  // prompt-history and composer drafts are user-typed text: intentionally untouched

  if (JSON.stringify(json) === before) return;
  const pretty = /\n\s+"/.test(raw);
  fs.writeFileSync(FILES.globalState, JSON.stringify(json, null, pretty ? 2 : 0) + (raw.endsWith("\n") ? "\n" : ""));
}

function patchAmbientFiles(plan) {
  for (const file of plan.touchedFiles.filter((item) => item.endsWith("ambient-suggestions.json"))) {
    const raw = safeReadText(file);
    const json = safeReadJson(file);
    if (!json) continue;
    const renamed = replacePathAny(json.projectRoot, plan.pairs);
    if (renamed === json.projectRoot) continue;
    json.projectRoot = renamed;
    const pretty = /\n\s+"/.test(raw);
    fs.writeFileSync(file, JSON.stringify(json, null, pretty ? 2 : 0) + (raw.endsWith("\n") ? "\n" : ""));
  }
}

function patchSessionFiles(plan) {
  const files = plan.touchedFiles.filter((file) => file.endsWith(".jsonl"));
  let done = 0;
  for (const file of files) {
    const text = safeReadText(file);
    const hadTrailingNewline = text.endsWith("\n");
    const lines = text.split("\n");
    if (hadTrailingNewline) lines.pop();
    let changed = false;
    const patched = lines.map((line) => {
      if (!line.trim()) return line;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return line; // corrupt line: keep byte-for-byte, never crash mid-apply
      }
      const before = JSON.stringify(obj);
      patchSessionObject(obj, plan.pairs);
      const after = JSON.stringify(obj);
      if (after !== before) changed = true;
      return after !== before ? after : line;
    });
    if (changed) fs.writeFileSync(file, patched.join("\n") + (hadTrailingNewline ? "\n" : ""));
    done += 1;
    if (done === 1) injectFail("mid-sessions");
  }
}

function patchSessionObject(obj, pairs) {
  const swap = (value) => replacePathAny(value, pairs);
  if (obj.type === "session_meta" && obj.payload?.cwd) obj.payload.cwd = swap(obj.payload.cwd);
  if (obj.type !== "turn_context") return;
  const payload = obj.payload || {};
  if (payload.cwd) payload.cwd = swap(payload.cwd);
  if (Array.isArray(payload.workspace_roots)) payload.workspace_roots = dedupe(payload.workspace_roots.map(swap));
  for (const entries of [payload.permission_profile?.file_system?.entries, payload.file_system_sandbox_policy?.entries]) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry?.path?.path === "string") entry.path.path = swap(entry.path.path);
    }
  }
  if (Array.isArray(payload.sandbox_policy?.writable_roots)) {
    payload.sandbox_policy.writable_roots = dedupe(payload.sandbox_policy.writable_roots.map(swap));
  }
}

function patchSqlite(pairs) {
  const conditions = pairs
    .map(
      (pair) =>
        `cwd=${sqlQuote(pair.oldPath)} or cwd like ${sqlLikePrefix(pair.oldPath)} or sandbox_policy like ${sqlQuote(`%${pair.oldPath}%`)}`,
    )
    .join(" or ");
  const rows = sqliteJson(`select id, cwd, sandbox_policy from threads where ${conditions};`);
  if (!rows.length) return;

  const statements = ["begin immediate;"];
  for (const row of rows) {
    const cwd = row.cwd === null ? null : replacePathAny(row.cwd, pairs);
    let sandbox = row.sandbox_policy;
    if (typeof sandbox === "string" && sandbox) {
      try {
        const parsed = JSON.parse(sandbox);
        // deep walk: every string that is the old path or nested under it moves,
        // wherever the sandbox JSON shape puts it
        const patched = deepReplacePaths(parsed, pairs);
        sandbox = JSON.stringify(patched);
      } catch {
        // unparseable sandbox_policy: leave as-is; postflight reports it
      }
    }
    statements.push(
      `update threads set cwd=${sqlQuoteNullable(cwd)}, sandbox_policy=${sqlQuoteNullable(sandbox)} where id=${sqlQuote(row.id)};`,
    );
  }
  statements.push("commit;");
  sqliteExec(statements.join("\n"));
}

function deepReplacePaths(value, pairs) {
  if (typeof value === "string") return replacePathAny(value, pairs);
  if (Array.isArray(value)) return value.map((item) => deepReplacePaths(item, pairs));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepReplacePaths(item, pairs);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

function sqliteCheckpoint() {
  if (fs.existsSync(FILES.sqliteWal)) sqliteExec("PRAGMA wal_checkpoint(TRUNCATE);");
}

function sqliteJson(sql) {
  const result = execFileSync("sqlite3", ["-json", FILES.sqlite, sql], { encoding: "utf8" });
  return JSON.parse(result || "[]");
}

function sqliteQuery(sql) {
  return execFileSync("sqlite3", [FILES.sqlite, sql], { encoding: "utf8" });
}

function sqliteExec(sql) {
  execFileSync("sqlite3", [FILES.sqlite, sql], { encoding: "utf8" });
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlQuoteNullable(value) {
  return value === null || value === undefined ? "NULL" : sqlQuote(value);
}

function sqlLikePrefix(prefix) {
  const escaped = String(prefix).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  return `${sqlQuote(`${escaped}/%`)} escape '\\'`;
}

function ensureCodexClosed() {
  if (CODEX_HOME !== DEFAULT_CODEX_HOME) return; // fixture/test homes: app check is meaningless
  const ps = execFileSync("ps", ["-axo", "pid=,comm=,args="], { encoding: "utf8" });
  const running = ps
    .split("\n")
    .filter((line) => line.includes("/Applications/Codex.app/") || line.includes("Codex Helper"));
  if (running.length) {
    console.error("Codex appears to be running. Close Codex.app fully before applying.");
    console.error(running.join("\n"));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Non-interactive commands
// ---------------------------------------------------------------------------

function cmdScan() {
  const projects = discoverProjects();
  const groups = groupByParent(projects);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(groups.map((group) => ({
      parent: group.parent,
      projects: group.projects.map((project) => ({ path: project.path, ...serializeCounts(project.counts) })),
    })), null, 2));
    return;
  }
  if (!groups.length) return console.log("No Codex projects found.");
  console.log(`Codex home: ${CODEX_HOME}\n`);
  for (const group of groups) {
    console.log(`${group.parent}  (${group.projects.length} project${group.projects.length === 1 ? "" : "s"})`);
    for (const project of group.projects) {
      console.log(`  ${project.basename}  ${formatCounts(project.counts)}`);
    }
  }
}

function serializeCounts(counts) {
  return {
    config: counts.config,
    global: counts.global,
    threads: counts.threads,
    sessionFiles: counts.sessionFiles.size,
    ambientFiles: counts.ambientFiles.size,
  };
}

function formatCounts(counts) {
  const c = serializeCounts(counts);
  return `[threads=${c.threads} sessions=${c.sessionFiles} config=${c.config} global=${c.global} ambient=${c.ambientFiles}]`;
}

// Read-only, cursor-scrollable version of cmdScan() for the interactive rich
// menu. Filters out nested projects (worktrees, subfolders) to match Migrate's
// project picker — avoid showing both parent and child in the same list.
// cmdScan() itself (the --scan/--scan --json CLI path) is untouched.
async function scanFlowRich(rl) {
  const projects = discoverProjects();
  const groups = groupByParent(nonNestedProjects(projects));
  const rows = groups.flatMap((group) => group.projects.map((project) => ({ group, project })));
  if (!rows.length) {
    clearScreen();
    output.write("No Codex projects found.\r\n\r\nPress enter to go back to the menu.\r\n");
    await rl.question("");
    return;
  }
  const ctx = { cursor: 0 };
  const rowText = (index, isCursor) => {
    const { group, project } = rows[index];
    const line = `${project.basename}  (${group.parent})`;
    return styleRow(line, isCursor, output.columns || 80);
  };
  const detailLines = (index) => [`counts: ${formatCounts(rows[index].project.counts)}`];
  const onKey = (key, str) => {
    if (key?.name === "return" || key?.name === "escape" || str === "q") return "back";
  };
  await runRichList(rl, {
    rows,
    headerLines: () => [`Codex home: ${CODEX_HOME}`, `Scan — ${rows.length} project(s) across ${groups.length} folder(s)`],
    rowText,
    detailLines,
    footer: "↑/↓ move  q/enter=back to menu",
    ctx,
    onKey,
  });
}

function resolveNonInteractiveSelection() {
  const origin = getArgValue("--origin");
  const dest = getArgValue("--dest");
  if (!origin || !dest) fail("Both --origin and --dest are required.");
  const originParent = normalizePath(origin);
  const destinationParent = normalizePath(dest);
  if (originParent === destinationParent) fail("Origin and destination parents are the same.");

  const projects = discoverProjects();
  const entries = buildProjectEntries(projects, originParent, destinationParent);
  const filter = getArgValue("--projects");
  let selected = entries;
  if (filter) {
    const wanted = filter.split(",").map((item) => item.trim()).filter(Boolean);
    selected = entries.filter((entry) =>
      wanted.some((want) => entry.oldPath === normalizePath(want) || path.basename(entry.oldPath) === want),
    );
    const foundNames = new Set(selected.map((entry) => path.basename(entry.oldPath)));
    const foundPaths = new Set(selected.map((entry) => entry.oldPath));
    for (const want of wanted) {
      if (!foundNames.has(want) && !foundPaths.has(normalizePath(want))) {
        fail(`Project not found under ${originParent}: ${want}`);
      }
    }
  }
  return { originParent, destinationParent, entries, selected };
}

function cmdPlan() {
  const { originParent, destinationParent, selected } = resolveNonInteractiveSelection();
  const eligible = selected.filter((entry) => entry.eligible);
  const plan = buildPlan(originParent, destinationParent, eligible, argv.includes("--copy-folders"));
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ plan, notEligible: selected.filter((entry) => !entry.eligible) }, null, 2));
    return;
  }
  printPlanSummary(plan, selected.filter((entry) => !entry.eligible));
}

function cmdApply() {
  const { originParent, destinationParent, selected } = resolveNonInteractiveSelection();
  if (!argv.includes("--yes")) fail("--apply requires --yes (or run interactively without flags).");
  const notEligible = selected.filter((entry) => !entry.eligible);
  if (notEligible.length) {
    for (const entry of notEligible) console.error(`Not eligible: ${entry.oldPath} (${entry.blockers.join("; ")})`);
    fail("Remove ineligible projects from --projects and retry.");
  }
  if (!selected.length) fail("No projects selected.");
  const plan = buildPlan(originParent, destinationParent, selected, argv.includes("--copy-folders"));
  printPlanSummary(plan, []);
  applyPlan(plan);
}

function cmdRestore() {
  const value = getArgValue("--restore") || "latest";
  const backups = listBackups();
  let dir;
  if (value === "latest") {
    if (!backups.length) fail(`No backups found under ${BACKUP_ROOT}`);
    dir = backups[0].dir;
  } else {
    dir = path.resolve(value);
    if (!fs.existsSync(path.join(dir, "manifest.json"))) fail(`Not a backup directory (no manifest.json): ${dir}`);
  }
  ensureCodexClosed();
  console.log(`Restoring from: ${dir}`);
  restoreBackup(dir);
}

// ---------------------------------------------------------------------------
// Interactive UI
// ---------------------------------------------------------------------------

// readline drops 'line' events that arrive while no question is pending —
// piped/scripted input delivers everything in one chunk, so buffer lines
// in a queue and hand them out one question at a time
function makePrompter() {
  let rl = createInterface({ input, output });
  const queue = [];
  const waiters = [];
  let closed = false;
  let tearingDown = false; // true while we intentionally close/reopen the

  // interface around a raw-mode rich-UI session (see pauseForRawMode below) —
  // distinguishes that from a real EOF on stdin.
  function wire(instance) {
    instance.on("line", (line) => {
      if (waiters.length) waiters.shift()({ line });
      else queue.push(line);
    });
    instance.on("close", () => {
      if (tearingDown) return;
      closed = true;
      while (waiters.length) waiters.shift()({ eof: true });
    });
  }
  wire(rl);

  return {
    async question(promptText) {
      if (queue.length) {
        output.write(promptText);
        return queue.shift();
      }
      if (closed) throw new Error("Input closed before the prompt was answered. Nothing was applied.");
      rl.setPrompt(promptText);
      rl.prompt();
      const result = await new Promise((resolve) => waiters.push(resolve));
      if (result.eof) throw new Error("Input closed before the prompt was answered. Nothing was applied.");
      return result.line;
    },
    close() {
      rl.close();
    },
    // The rich (alternate-screen, raw-key) UI needs exclusive control of
    // stdin's keypress events. A live readline.Interface reacts to every
    // keypress on its own (line editing, echo), so it has to be fully torn
    // down while the rich UI runs, then rebuilt identically afterwards.
    pauseForRawMode() {
      tearingDown = true;
      rl.close();
      process.nextTick(() => {
        tearingDown = false;
      });
    },
    resumeFromRawMode() {
      rl = createInterface({ input, output });
      wire(rl);
    },
  };
}

async function interactiveMain() {
  const rl = makePrompter();
  try {
    if (supportsRichTTY()) await interactiveMainRich(rl);
    else await interactiveMainPlain(rl);
  } finally {
    rl.close();
  }
}

async function interactiveMainPlain(rl) {
  console.log(`codex-folder-move — Codex home: ${CODEX_HOME}`);
  while (true) {
    console.log("\nMain menu");
    console.log("  1. Migrate projects");
    console.log("  2. Scan Codex state");
    console.log("  3. Restore from backup");
    console.log("  4. Quit");
    const answer = (await rl.question("Choose 1-4: ")).trim();
    if (answer === "1") await migrateFlowPlain(rl);
    else if (answer === "2") cmdScan();
    else if (answer === "3") await restoreFlowPlain(rl);
    else if (answer === "4" || answer.toLowerCase() === "q") return console.log("No action taken. Bye.");
    else console.log("Invalid choice.");
  }
}

// One alternate-screen session per menu cycle: entered fresh at the top of
// every loop iteration, kept open through the whole chosen flow's navigation
// (pickers/checklist/summary), and closed by that flow itself right before
// it prints anything the user should keep in real scrollback. See
// migrateFlowRich/scanFlowRich/restoreFlowRich for how each flow honors that.
async function interactiveMainRich(rl) {
  while (true) {
    enterAltScreen();
    clearScreen();
    const ctx = { cursor: 0 };
    const rowText = (index, isCursor) => styleRow(`${MENU_OPTIONS[index].key}. ${MENU_OPTIONS[index].label}`, isCursor, output.columns || 80);
    const onKey = (key, str) => {
      const direct = MENU_OPTIONS.findIndex((option) => option.key === str);
      if (direct >= 0) {
        ctx.cursor = direct;
        return "done";
      }
      if (key?.name === "return") return "done";
      if (key?.name === "escape" || str === "q") return "quit-key";
    };
    const result = await runRichList(rl, {
      rows: MENU_OPTIONS,
      headerLines: () => [`codex-folder-move — ${CODEX_HOME}`, "Main menu"],
      rowText,
      detailLines: null,
      footer: "↑/↓ move  enter=select  1-4=jump  q=quit",
      ctx,
      onKey,
    });
    const action = result === "quit-key" ? "quit" : MENU_OPTIONS[ctx.cursor].action;
    if (action === "quit") {
      exitAltScreen();
      console.log("No action taken. Bye.");
      return;
    }
    if (action === "migrate") await migrateFlowRich(rl);
    else if (action === "scan") await scanFlowRich(rl);
    else if (action === "restore") await restoreFlowRich(rl);
  }
}

async function migrateFlow(rl) {
  if (supportsRichTTY()) return migrateFlowRich(rl);
  return migrateFlowPlain(rl);
}

async function migrateFlowPlain(rl) {
  console.log("\nScanning Codex state...");
  const projects = discoverProjects();
  if (!projects.length) return console.log("No Codex projects found.");
  const groups = groupByParent(nonNestedProjects(projects));

  const originParent = await pickParentPlain(rl, groups, "origin", null);
  if (!originParent) return;
  const destinationParent = await pickParentPlain(rl, groups, "destination", originParent);
  if (!destinationParent) return;
  if (!fs.existsSync(destinationParent)) {
    const create = (await rl.question(`Destination parent does not exist. Create ${destinationParent}? (y/n): `)).trim().toLowerCase();
    if (create !== "y") return console.log("Cancelled.");
    fs.mkdirSync(destinationParent, { recursive: true });
  }

  console.log("\nAnalyzing projects (counting references in every store)...");
  const entries = buildProjectEntries(projects, originParent, destinationParent);
  if (!entries.length) return console.log(`Nothing found under ${originParent}.`);

  const selected = await checklistPlain(rl, entries);
  if (!selected || !selected.length) return console.log("Nothing selected. Cancelled.");

  let copyFolders = false;
  const needCopy = selected.filter((entry) => entry.folderAction === "copy");
  if (needCopy.length) {
    console.log(`\n${needCopy.length} selected project(s) have no folder at the destination yet:`);
    for (const entry of needCopy) console.log(`  ${entry.oldPath}`);
    const answer = (await rl.question("Copy these folders to the destination? Sources are never deleted. (y/n): "))
      .trim()
      .toLowerCase();
    copyFolders = answer === "y";
    if (!copyFolders) console.log("OK — metadata only; Codex will point at folders that don't exist yet.");
  }

  const plan = buildPlan(originParent, destinationParent, selected, copyFolders);
  printPlanSummary(plan, []);
  console.log(`\nA full backup of all ${plan.touchedFiles.length} touched files is taken first.`);
  console.log("Any error triggers an automatic checksum-verified restore.");
  const confirm = (await rl.question('Type "migrate" to proceed, anything else to cancel: ')).trim();
  if (confirm !== "migrate") return console.log("Cancelled. Nothing was changed.");

  applyPlan(plan);
}

// Alt-screen is entered once by interactiveMainRich right before dispatching
// here and stays open through every picker/checklist/summary screen below —
// this function's only job is to call exitAltScreen() exactly once, right
// before it needs to print something the user should keep in real scrollback
// (a cancellation, or the actual apply's output), then do that printing with
// plain console.log/applyPlan exactly like the plain flow does.
async function migrateFlowRich(rl) {
  const projects = discoverProjects();
  if (!projects.length) {
    exitAltScreen();
    console.log("No Codex projects found.");
    return;
  }
  const groups = groupByParent(nonNestedProjects(projects));

  const originParent = await pickParentRich(rl, groups, "origin", null);
  if (!originParent) {
    exitAltScreen();
    return;
  }
  const destinationParent = await pickParentRich(rl, groups, "destination", originParent);
  if (!destinationParent) {
    exitAltScreen();
    return;
  }
  if (!fs.existsSync(destinationParent)) {
    clearScreen();
    const create = (
      await rl.question(`Destination parent does not exist. Create ${destinationParent}? (y/n): `)
    ).trim().toLowerCase();
    if (create !== "y") {
      exitAltScreen();
      console.log("Cancelled.");
      return;
    }
    fs.mkdirSync(destinationParent, { recursive: true });
  }

  const entries = buildProjectEntries(projects, originParent, destinationParent);
  if (!entries.length) {
    exitAltScreen();
    console.log(`Nothing found under ${originParent}.`);
    return;
  }

  const selected = await checklistRich(rl, entries);
  if (!selected || !selected.length) {
    exitAltScreen();
    console.log("Nothing selected. Cancelled.");
    return;
  }

  let copyFolders = false;
  const needCopy = selected.filter((entry) => entry.folderAction === "copy");
  if (needCopy.length) {
    clearScreen();
    output.write(
      [`${needCopy.length} selected project(s) have no folder at the destination yet:`, ...needCopy.map((e) => `  ${e.oldPath}`), ""].join(
        "\r\n",
      ),
    );
    const answer = (
      await rl.question("\nCopy these folders to the destination? Sources are never deleted. (y/n): ")
    ).trim().toLowerCase();
    copyFolders = answer === "y";
  }

  const plan = buildPlan(originParent, destinationParent, selected, copyFolders);
  clearScreen();
  output.write(
    [
      ...planSummaryLines(plan, []),
      "",
      `A full backup of all ${plan.touchedFiles.length} touched files is taken first.`,
      "Any error triggers an automatic checksum-verified restore.",
      "",
    ].join("\r\n"),
  );
  const confirm = (await rl.question('Type "migrate" to proceed, anything else to cancel: ')).trim();
  exitAltScreen();
  if (confirm !== "migrate") return console.log("Cancelled. Nothing was changed.");

  applyPlan(plan);
}

// ---------------------------------------------------------------------------
// Rich interactive TUI (alternate screen, raw keys, cursor + detail pane)
// ---------------------------------------------------------------------------
// Automatically falls back to the plain line-mode prompts above whenever
// stdin/stdout aren't a real TTY (piped fixture tests, non-interactive
// scripts), so that path stays exactly as it was — untouched, still tested
// by every existing fixture case.

function supportsRichTTY() {
  return Boolean(input.isTTY && output.isTTY);
}

function enterAltScreen() {
  richModeActive = true;
  output.write(`${ESC}[?1049h${ESC}[?25l`);
}
function exitAltScreen() {
  output.write(`${ESC}[?25h${ESC}[?1049l`);
  richModeActive = false;
}
function clearScreen() {
  output.write(`${ESC}[2J${ESC}[H`);
}

// Never leave the user's shell stuck in raw mode / the alternate screen if
// the process dies mid-session. Covers two distinct paths: (1) an uncaught
// error or a plain process.exit() call, which reliably fires the "exit"
// event; (2) an external signal (SIGINT/SIGTERM — e.g. `kill`, a supervisor,
// or Ctrl+C reaching the process while ISIG is still enabled somewhere
// upstream) which does NOT fire "exit" unless something calls process.exit()
// in response — Node's default disposition for an unhandled signal
// terminates the process directly, bypassing "exit" entirely. A literal
// Ctrl+C keystroke *while our own raw mode is active* is handled separately,
// in-band, by runRichList's keypress handler (hardAbort), since setRawMode
// disables ISIG and the keystroke never becomes a signal in that case.
function restoreTerminalNow() {
  if (!richModeActive) return;
  if (input.isTTY && input.isRaw) input.setRawMode(false);
  output.write(`${ESC}[?25h${ESC}[?1049l`);
  richModeActive = false;
}
process.on("exit", restoreTerminalNow);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restoreTerminalNow();
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  });
}

function captureRawKeys(rl) {
  rl.pauseForRawMode();
  emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);
  input.resume();
}
function releaseRawKeys(rl) {
  if (input.isTTY) input.setRawMode(false);
  rl.resumeFromRawMode();
}

function hardAbort(rl) {
  releaseRawKeys(rl);
  exitAltScreen();
  process.exit(130);
}

// Cursor position is marked with a "▶ " prefix plus bold/color text — not
// bare reverse-video. Reverse-video alone doesn't read as clearly across
// terminal color schemes, and (see the bug this replaced) is fragile: pad a
// reverse-video line to the column width, wrap it in escape codes, then
// truncate the RESULT by raw character count, and the reset code itself gets
// sliced off — the highlight then never turns back off and bleeds into every
// row after it. Fix: truncate the plain text to width first, wrap in escape
// codes after, and never touch the styled string's length again.
function cursorArrow(isCursor) {
  return isCursor ? "▶ " : "  ";
}
function styleText(plainText, isCursor, width) {
  const budget = Math.max(1, width);
  const truncated = plainText.length > budget ? plainText.slice(0, budget - 1) + "…" : plainText;
  return isCursor ? `${BOLD}${CYAN}${truncated}${RESET}` : truncated;
}
// Convenience for the common case: arrow prefix + styled text, nothing between.
function styleRow(plainText, isCursor, width) {
  return cursorArrow(isCursor) + styleText(plainText, isCursor, Math.max(1, width - 2));
}

// Cursor-driven, scrollable list rendered in the alternate screen. Callers
// own the alternate-screen lifecycle (enterAltScreen/exitAltScreen) — this
// function only owns raw-key capture and the render loop, so a flow can call
// it several times in a row (origin picker, destination picker, checklist)
// without the screen flashing in and out between each one. `onKey` mutates
// `ctx` as needed and returns a token to end the loop (anything other than
// undefined); the caller decides what each token means.
async function runRichList(rl, { rows, headerLines, rowText, detailLines, footer, ctx, onKey }) {
  captureRawKeys(rl);
  let offset = 0;
  let listHeight = 1;
  const render = () => {
    const cols = output.columns || 80;
    const termRows = output.rows || 24;
    const detailHeight = detailLines ? 5 : 0;
    const chrome = headerLines().length + 1 + (detailHeight ? detailHeight + 2 : 0) + 1;
    listHeight = Math.max(3, termRows - chrome);
    if (ctx.cursor < offset) offset = ctx.cursor;
    if (ctx.cursor >= offset + listHeight) offset = ctx.cursor - listHeight + 1;
    offset = Math.max(0, Math.min(offset, Math.max(0, rows.length - listHeight)));
    const visible = rows.slice(offset, offset + listHeight);

    const out = [...headerLines(), ""];
    visible.forEach((_, i) => {
      const index = offset + i;
      out.push(rowText(index, index === ctx.cursor));
    });
    for (let i = visible.length; i < listHeight; i++) out.push("");
    if (detailHeight) {
      out.push("─".repeat(Math.min(cols, 70)));
      const lines = rows.length ? detailLines(ctx.cursor) : [];
      for (let i = 0; i < detailHeight; i++) out.push((lines[i] || "").slice(0, cols));
      out.push("─".repeat(Math.min(cols, 70)));
    }
    out.push(footer.slice(0, cols));
    clearScreen();
    output.write(out.join("\r\n"));
  };
  render();
  const onResize = () => render();
  output.on("resize", onResize);
  try {
    return await new Promise((resolve) => {
      const onKeypress = (str, key) => {
        if (key?.ctrl && key.name === "c") return hardAbort(rl);
        if (key?.name === "pageup" || str === "<") ctx.cursor = Math.max(0, ctx.cursor - listHeight);
        else if (key?.name === "pagedown" || str === ">") ctx.cursor = Math.min(rows.length - 1, ctx.cursor + listHeight);
        else if (key?.name === "up") ctx.cursor = Math.max(0, ctx.cursor - 1);
        else if (key?.name === "down") ctx.cursor = Math.min(rows.length - 1, ctx.cursor + 1);
        else {
          const result = onKey(key, str, ctx);
          if (result !== undefined) {
            input.removeListener("keypress", onKeypress);
            resolve(result);
            return;
          }
        }
        render();
      };
      input.on("keypress", onKeypress);
    });
  } finally {
    output.removeListener("resize", onResize);
    releaseRawKeys(rl);
  }
}

async function pickCustomPath(rl, label, exclude) {
  while (true) {
    const custom = (await rl.question(`${capitalize(label)} parent — custom path (blank to cancel): `)).trim();
    if (!custom) return null;
    const normalized = normalizePath(custom);
    if (normalized === exclude) {
      console.log("Origin and destination must differ.");
      continue;
    }
    return normalized;
  }
}

async function pickParentRich(rl, groups, label, exclude) {
  const options = groups.filter((group) => group.parent !== exclude);
  if (!options.length) return pickCustomPath(rl, label, exclude);

  const ctx = { cursor: 0 };
  const rowText = (index, isCursor) => {
    const group = options[index];
    const line = `${String(index + 1).padStart(3)}. ${group.parent}  (${group.projects.length} Codex project${group.projects.length === 1 ? "" : "s"})`;
    return styleRow(line, isCursor, output.columns || 80);
  };
  const onKey = (key, str) => {
    if (key?.name === "return") return "done";
    if (str === "c") return "custom";
    if (key?.name === "escape" || str === "q") return "cancel";
  };
  const result = await runRichList(rl, {
    rows: options,
    headerLines: () => [`Select the ${label} parent folder (the folder that contains your projects):`],
    rowText,
    detailLines: null,
    footer: "↑/↓ move  enter=select  c=custom path  q=cancel",
    ctx,
    onKey,
  });
  if (result === "cancel") return null;
  if (result === "custom") return pickCustomPath(rl, label, exclude);
  return options[ctx.cursor].parent;
}

function folderStatusWord(entry) {
  if (entry.folderAction === "copy") return "needs folder copy";
  if (entry.oldExists && entry.destExists) return "folder on both sides";
  if (entry.destExists) return "folder at destination";
  return "folder missing both sides";
}

async function checklistRich(rl, entries) {
  const eligibleIndexes = entries.map((entry, index) => (entry.eligible ? index : -1)).filter((i) => i >= 0);
  const checked = new Set();
  const ctx = { cursor: 0 };

  const rowText = (index, isCursor) => {
    const entry = entries[index];
    const mark = !entry.eligible ? `${DIM} ✗ ${RESET}` : checked.has(index) ? `${GREEN}${BOLD}[x]${RESET}` : "[ ]";
    const status = entry.eligible ? folderStatusWord(entry) : "BLOCKED";
    const line = `${String(index + 1).padStart(3)}. ${path.basename(entry.oldPath)}  —  ${status}`;
    const budget = (output.columns || 80) - 6;
    const styledLine = entry.eligible ? styleText(line, isCursor, budget) : `${DIM}${styleText(line, false, budget)}${RESET}`;
    return `${cursorArrow(isCursor)}${mark} ${styledLine}`;
  };
  const detailLines = (index) => {
    const entry = entries[index];
    const lines = [entry.oldPath, `  -> ${entry.newPath}`];
    if (entry.refs) {
      const r = entry.refs;
      lines.push(
        `  threads=${r.sqliteCwdOld} sandbox=${r.sqliteSandboxOld} sessions=${r.sessionFiles.length} config=${r.configBlocksOld} global=${r.globalRefsOld} ambient=${r.ambientFiles.length}`,
      );
    }
    if (entry.blockers.length) lines.push(`  BLOCKED: ${entry.blockers.join("; ")}`);
    for (const warning of entry.warnings) lines.push(`  note: ${warning}`);
    return lines;
  };
  const onKey = (key, str) => {
    if (key?.name === "space") {
      const entry = entries[ctx.cursor];
      if (entry.eligible) {
        if (checked.has(ctx.cursor)) checked.delete(ctx.cursor);
        else checked.add(ctx.cursor);
      }
    } else if (str === "a") {
      for (const i of eligibleIndexes) checked.add(i);
    } else if (str === "n") {
      checked.clear();
    } else if (key?.name === "return" || str === "d") {
      return "done";
    } else if (key?.name === "escape" || str === "q") {
      return "cancel";
    }
  };
  const result = await runRichList(rl, {
    rows: entries,
    headerLines: () => [`codex-folder-move — ${entries.length} project(s), ${checked.size} selected`],
    rowText,
    detailLines,
    footer: "↑/↓ move  space toggle  a=all eligible  n=none  enter/d=done  q=cancel",
    ctx,
    onKey,
  });
  if (result === "cancel") return null;
  return [...checked].sort((a, b) => a - b).map((i) => entries[i]);
}

async function pickParent(rl, groups, label, exclude) {
  if (supportsRichTTY()) return pickParentRich(rl, groups, label, exclude);
  return pickParentPlain(rl, groups, label, exclude);
}

async function checklist(rl, entries) {
  if (supportsRichTTY()) return checklistRich(rl, entries);
  return checklistPlain(rl, entries);
}

async function pickParentPlain(rl, groups, label, exclude) {
  const options = groups.filter((group) => group.parent !== exclude);
  console.log(`\nSelect the ${label} parent folder (the folder that contains your projects):`);
  options.forEach((group, index) => {
    console.log(`  ${index + 1}. ${group.parent}  (${group.projects.length} Codex project${group.projects.length === 1 ? "" : "s"})`);
  });
  console.log(`  c. Enter a custom path`);
  console.log(`  q. Cancel`);
  while (true) {
    const answer = (await rl.question(`${capitalize(label)} parent: `)).trim();
    if (answer.toLowerCase() === "q") return null;
    if (answer.toLowerCase() === "c") {
      const custom = (await rl.question("Path: ")).trim();
      if (!custom) continue;
      const normalized = normalizePath(custom);
      if (normalized === exclude) {
        console.log("Origin and destination must differ.");
        continue;
      }
      return normalized;
    }
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1].parent;
    console.log("Invalid choice.");
  }
}

async function checklistPlain(rl, entries) {
  const pageSize = 10;
  let page = 0;
  const checked = new Set(); // indexes into entries
  const eligibleIndexes = entries.map((entry, index) => (entry.eligible ? index : -1)).filter((index) => index >= 0);

  while (true) {
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    page = Math.min(Math.max(page, 0), totalPages - 1);
    const start = page * pageSize;
    const visible = entries.slice(start, start + pageSize);

    console.log(`\nProjects (page ${page + 1}/${totalPages}, ${checked.size} selected)`);
    visible.forEach((entry, offset) => {
      const index = start + offset;
      const mark = entry.eligible ? (checked.has(index) ? "[x]" : "[ ]") : " ✗ ";
      const folder =
        entry.folderAction === "copy"
          ? "folder: needs copy to destination"
          : entry.oldExists && entry.destExists
            ? "folder: exists on both sides"
            : entry.destExists
              ? "folder: already at destination"
              : "folder: missing on both sides";
      console.log(`${mark} ${index + 1}. ${path.basename(entry.oldPath)}`);
      console.log(`      ${entry.oldPath} -> ${entry.newPath}`);
      if (entry.refs) {
        const refs = entry.refs;
        console.log(
          `      threads=${refs.sqliteCwdOld} sandbox=${refs.sqliteSandboxOld} sessions=${refs.sessionFiles.length} config=${refs.configBlocksOld} global=${refs.globalRefsOld} ambient=${refs.ambientFiles.length} | ${folder}`,
        );
      }
      if (entry.blockers.length) console.log(`      BLOCKED: ${entry.blockers.join("; ")}`);
      for (const warning of entry.warnings) console.log(`      note: ${warning}`);
    });

    const answer = (
      await rl.question("\nToggle: number(s) e.g. 1,3 or 2-5 | a=all eligible | n=none | > next | < prev | d=done | q=cancel: ")
    )
      .trim()
      .toLowerCase();
    if (answer === "q") return null;
    if (answer === "d") return [...checked].sort((a, b) => a - b).map((index) => entries[index]);
    if (answer === "a") {
      for (const index of eligibleIndexes) checked.add(index);
      continue;
    }
    if (answer === "n") {
      checked.clear();
      continue;
    }
    if (answer === ">" || answer === "next") {
      page += 1;
      continue;
    }
    if (answer === "<" || answer === "prev") {
      page -= 1;
      continue;
    }
    const indexes = parseSelection(answer, entries.length);
    if (!indexes) {
      console.log("Invalid input.");
      continue;
    }
    for (const index of indexes) {
      const entry = entries[index];
      if (!entry.eligible) {
        console.log(`Cannot select ${index + 1}: ${entry.blockers.join("; ")}`);
        continue;
      }
      if (checked.has(index)) checked.delete(index);
      else checked.add(index);
    }
  }
}

function parseSelection(text, max) {
  const out = new Set();
  for (const part of text.split(",").map((item) => item.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to > max || from > to) return null;
      for (let i = from; i <= to; i++) out.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const index = Number(part);
      if (index < 1 || index > max) return null;
      out.add(index - 1);
    } else {
      return null;
    }
  }
  return out.size ? [...out] : null;
}

function planSummaryLines(plan, notEligible) {
  const lines = ["Migration plan"];
  lines.push(`  Origin parent:      ${plan.originParent}`);
  lines.push(`  Destination parent: ${plan.destinationParent}`);
  lines.push(`  Projects:           ${plan.projects.length}`);
  for (const project of plan.projects) {
    const e = project.expected;
    lines.push(`    ${path.basename(project.oldPath)}  [${project.folderAction}]`);
    lines.push(`      ${project.oldPath} -> ${project.newPath}`);
    lines.push(
      `      threads=${e.sqliteCwdOld} sandbox=${e.sqliteSandboxOld} sessions=${e.sessionFiles} config=${e.configBlocksOld} global=${e.globalRefsOld} ambient=${e.ambientFiles}`,
    );
    for (const warning of project.warnings) lines.push(`      note: ${warning}`);
  }
  if (plan.folderCopies.length) {
    lines.push(`  Folder copies (source never deleted): ${plan.folderCopies.length}`);
  }
  lines.push(`  Files to modify: ${plan.touchedFiles.length}`);
  lines.push(`  Backup location: ${BACKUP_ROOT}`);
  for (const entry of notEligible || []) {
    lines.push(`  NOT ELIGIBLE: ${entry.oldPath} (${entry.blockers.join("; ")})`);
  }
  return lines;
}
function printPlanSummary(plan, notEligible) {
  console.log("\n" + planSummaryLines(plan, notEligible).join("\n"));
}

async function restoreFlow(rl) {
  if (supportsRichTTY()) return restoreFlowRich(rl);
  return restoreFlowPlain(rl);
}

async function restoreFlowPlain(rl) {
  const backups = listBackups();
  if (!backups.length) return console.log(`No backups found under ${BACKUP_ROOT}`);
  console.log("\nBackups (newest first):");
  backups.slice(0, 15).forEach((backup, index) => {
    console.log(`  ${index + 1}. ${backup.name}`);
  });
  const answer = (await rl.question("Restore which backup? (number, q to cancel): ")).trim();
  if (answer.toLowerCase() === "q") return;
  const index = Number(answer);
  if (!Number.isInteger(index) || index < 1 || index > Math.min(backups.length, 15)) {
    return console.log("Invalid choice.");
  }
  const dir = backups[index - 1].dir;
  const confirm = (await rl.question(`Type "restore" to overwrite current Codex state from ${backups[index - 1].name}: `)).trim();
  if (confirm !== "restore") return console.log("Cancelled.");
  ensureCodexClosed();
  restoreBackup(dir);
}

async function restoreFlowRich(rl) {
  const backups = listBackups();
  if (!backups.length) {
    exitAltScreen();
    console.log(`No backups found under ${BACKUP_ROOT}`);
    return;
  }
  const visible = backups.slice(0, 15);
  const ctx = { cursor: 0 };
  const rowText = (index, isCursor) => styleRow(visible[index].name, isCursor, output.columns || 80);
  const onKey = (key, str) => {
    if (key?.name === "return") return "done";
    if (key?.name === "escape" || str === "q") return "cancel";
  };
  const result = await runRichList(rl, {
    rows: visible,
    headerLines: () => ["Backups (newest first):"],
    rowText,
    detailLines: null,
    footer: "↑/↓ move  enter=select  q=cancel",
    ctx,
    onKey,
  });
  if (result === "cancel") {
    exitAltScreen();
    return;
  }
  const chosen = visible[ctx.cursor];
  clearScreen();
  output.write(`Selected: ${chosen.name}\r\n\r\n`);
  const confirm = (await rl.question(`Type "restore" to overwrite current Codex state from ${chosen.name}: `)).trim();
  exitAltScreen();
  if (confirm !== "restore") return console.log("Cancelled.");
  ensureCodexClosed();
  restoreBackup(chosen.dir);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function getArgValue(flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function walkFiles(root, suffix) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(file, suffix));
    else if (entry.isFile() && file.endsWith(suffix)) out.push(file);
  }
  return out.sort();
}

function dedupe(array) {
  return [...new Set(array)];
}

function realpathOrNull(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function safeReadText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
