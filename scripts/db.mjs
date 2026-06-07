#!/usr/bin/env node

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureDir,
  fileSha256,
  formatBytes,
  getRuntimeConfig,
  logEvent,
  projectRoot,
  readDirSafe,
  readJsonFile,
  relativeToProject,
  timestampForFile,
  withTimedOperation,
  writeJsonFileAtomic
} from "./lib/ops.mjs";

const CURRENT_KIND = "fundx.local-json-db";
const migrationDir = path.join(projectRoot, "scripts", "migrations");
const requiredCollections = [
  "markets",
  "funds",
  "stocks",
  "portfolios",
  "watchlist",
  "customFunds",
  "dcaPlans",
  "reports",
  "userPreferences",
  "auditEvents"
];

function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
      if (inlineValue !== undefined) {
        values.set(rawKey, inlineValue);
      } else if (argv[index + 1] && !argv[index + 1].startsWith("-")) {
        values.set(rawKey, argv[index + 1]);
        index += 1;
      } else {
        flags.add(rawKey);
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, values, positional };
}

function printHelp() {
  console.log(`FundX DB operations

Usage:
  node scripts/db.mjs init [--force]
  node scripts/db.mjs migrate
  node scripts/db.mjs status
  node scripts/db.mjs verify
  node scripts/db.mjs backup [--label daily]
  node scripts/db.mjs restore <backup-json> --yes
  node scripts/db.mjs prune-backups

Environment:
  FUNDX_DB_FILE, FUNDX_DATA_DIR, FUNDX_BACKUP_DIR, FUNDX_LOG_DIR, FUNDX_SLOW_QUERY_MS
`);
}

function emptyDatabase(now = new Date().toISOString()) {
  return {
    kind: CURRENT_KIND,
    schemaVersion: 0,
    createdAt: now,
    migratedAt: null,
    migrations: [],
    data: {}
  };
}

async function loadMigrations() {
  const files = readDirSafe(migrationDir).filter((file) => file.endsWith(".mjs")).sort();
  const migrations = [];

  for (const file of files) {
    const modulePath = path.join(migrationDir, file);
    const migration = await import(pathToFileURL(modulePath).href);
    if (!migration.id || typeof migration.version !== "number" || typeof migration.up !== "function") {
      throw new Error(`Invalid migration module: ${relativeToProject(modulePath)}`);
    }
    migrations.push({
      id: migration.id,
      version: migration.version,
      description: migration.description ?? "",
      up: migration.up
    });
  }

  return migrations.sort((left, right) => left.version - right.version || left.id.localeCompare(right.id));
}

function loadDatabase(config, { allowMissing = false } = {}) {
  if (!existsSync(config.dbFile)) {
    if (allowMissing) {
      return null;
    }
    throw new Error(`DB file not found: ${relativeToProject(config.dbFile)}. Run "node scripts/db.mjs init" first.`);
  }
  return readJsonFile(config.dbFile);
}

function validateDatabase(db) {
  const issues = [];

  if (!db || typeof db !== "object" || Array.isArray(db)) {
    return ["database must be a JSON object"];
  }
  if (db.kind !== CURRENT_KIND) {
    issues.push(`kind must be ${CURRENT_KIND}`);
  }
  if (!Number.isInteger(db.schemaVersion) || db.schemaVersion < 1) {
    issues.push("schemaVersion must be an integer >= 1");
  }
  if (!Array.isArray(db.migrations)) {
    issues.push("migrations must be an array");
  }
  if (!db.data || typeof db.data !== "object" || Array.isArray(db.data)) {
    issues.push("data must be an object");
  } else {
    for (const collection of requiredCollections) {
      if (!Array.isArray(db.data[collection])) {
        issues.push(`data.${collection} must be an array`);
      }
    }
  }

  return issues;
}

async function migrateDatabase(config, { createIfMissing = true, backupBeforeMigrate = true } = {}) {
  const migrations = await loadMigrations();
  const now = new Date().toISOString();
  const existing = loadDatabase(config, { allowMissing: true });
  let db = existing ?? emptyDatabase(now);
  const applied = new Set(Array.isArray(db.migrations) ? db.migrations.map((migration) => migration.id) : []);
  const pending = migrations.filter((migration) => !applied.has(migration.id));

  if (!existing && !createIfMissing) {
    throw new Error(`DB file not found: ${relativeToProject(config.dbFile)}`);
  }
  if (pending.length === 0) {
    return { db, applied: [], pending: [] };
  }

  if (existing && backupBeforeMigrate) {
    await createBackup(config, { label: "pre-migrate", silent: true });
  }

  const appliedNow = [];
  for (const migration of pending) {
    const context = { now: new Date().toISOString(), config };
    db = migration.up(db, context);
    const migrationsList = Array.isArray(db.migrations) ? db.migrations : [];
    db.migrations = [
      ...migrationsList,
      {
        id: migration.id,
        version: migration.version,
        description: migration.description,
        appliedAt: context.now
      }
    ];
    db.schemaVersion = Math.max(Number(db.schemaVersion) || 0, migration.version);
    db.migratedAt = context.now;
    appliedNow.push(migration);
  }

  writeJsonFileAtomic(config.dbFile, db);
  return { db, applied: appliedNow, pending: [] };
}

function listBackups(config) {
  return readDirSafe(config.backupDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const filePath = path.join(config.backupDir, file);
      const stats = statSync(filePath);
      return {
        file,
        path: filePath,
        size: stats.size,
        mtime: stats.mtime
      };
    })
    .sort((left, right) => right.mtime.getTime() - left.mtime.getTime());
}

async function createBackup(config, { label = "", silent = false } = {}) {
  const db = loadDatabase(config);
  const issues = validateDatabase(db);
  if (issues.length > 0) {
    throw new Error(`Cannot back up invalid DB: ${issues.join("; ")}`);
  }

  ensureDir(config.backupDir);
  const safeLabel = label ? `-${label.replace(/[^A-Za-z0-9._-]+/g, "-")}` : "";
  const backupFile = path.join(config.backupDir, `fundx-db-${timestampForFile()}${safeLabel}.json`);
  writeFileSync(backupFile, readFileSync(config.dbFile));
  const sha = fileSha256(backupFile);
  writeFileSync(`${backupFile}.sha256`, `${sha}  ${path.basename(backupFile)}\n`, "utf8");
  logEvent("db.backup", {
    dbFile: relativeToProject(config.dbFile),
    backupFile: relativeToProject(backupFile),
    sha256: sha,
    size: statSync(backupFile).size
  });

  if (!silent) {
    console.log(`Backup created: ${relativeToProject(backupFile)} (${formatBytes(statSync(backupFile).size)})`);
    console.log(`SHA256: ${sha}`);
  }

  return backupFile;
}

function verifyBackupChecksum(backupFile) {
  const checksumFile = `${backupFile}.sha256`;
  if (!existsSync(checksumFile)) {
    return { status: "missing" };
  }

  const expected = readFileSync(checksumFile, "utf8").trim().split(/\s+/)[0];
  const actual = fileSha256(backupFile);
  return {
    status: expected === actual ? "ok" : "mismatch",
    expected,
    actual
  };
}

async function restoreBackup(config, backupFile) {
  const resolvedBackup = path.isAbsolute(backupFile) ? backupFile : path.resolve(projectRoot, backupFile);
  if (!existsSync(resolvedBackup)) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }

  const checksum = verifyBackupChecksum(resolvedBackup);
  if (checksum.status === "mismatch") {
    throw new Error(`Backup checksum mismatch: expected ${checksum.expected}, got ${checksum.actual}`);
  }

  const db = readJsonFile(resolvedBackup);
  const issues = validateDatabase(db);
  if (issues.length > 0) {
    throw new Error(`Backup is not a valid FundX DB: ${issues.join("; ")}`);
  }

  if (existsSync(config.dbFile)) {
    await createBackup(config, { label: "pre-restore", silent: true });
  }

  writeJsonFileAtomic(config.dbFile, db);
  logEvent("db.restore", {
    dbFile: relativeToProject(config.dbFile),
    backupFile: relativeToProject(resolvedBackup),
    checksumStatus: checksum.status
  });
  console.log(`Restored ${relativeToProject(resolvedBackup)} -> ${relativeToProject(config.dbFile)}`);
}

async function printStatus(config) {
  const migrations = await loadMigrations();
  const db = loadDatabase(config, { allowMissing: true });
  const backups = listBackups(config);

  console.log("FundX DB status");
  console.log(`  DB file: ${relativeToProject(config.dbFile)} ${existsSync(config.dbFile) ? `(${formatBytes(statSync(config.dbFile).size)})` : "(missing)"}`);
  console.log(`  Backup dir: ${relativeToProject(config.backupDir)} (${backups.length} backup${backups.length === 1 ? "" : "s"})`);

  if (!db) {
    console.log("  Schema: not initialized");
    console.log(`  Pending migrations: ${migrations.map((migration) => migration.id).join(", ") || "none"}`);
    return;
  }

  const applied = new Set(Array.isArray(db.migrations) ? db.migrations.map((migration) => migration.id) : []);
  const pending = migrations.filter((migration) => !applied.has(migration.id));
  console.log(`  Schema: v${db.schemaVersion ?? "unknown"}`);
  console.log(`  Applied migrations: ${applied.size}`);
  console.log(`  Pending migrations: ${pending.map((migration) => migration.id).join(", ") || "none"}`);
  console.log(`  Newest backup: ${backups[0] ? `${backups[0].file} (${backups[0].mtime.toISOString()})` : "none"}`);
}

function verifyDatabase(config) {
  const db = loadDatabase(config);
  const issues = validateDatabase(db);
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`FAIL ${issue}`);
    }
    process.exitCode = 1;
    return;
  }
  const sha = fileSha256(config.dbFile);
  console.log(`PASS DB verified: ${relativeToProject(config.dbFile)}`);
  console.log(`SHA256: ${sha}`);
}

function pruneBackups(config) {
  const cutoffMs = Date.now() - config.backupRetentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const backup of listBackups(config)) {
    if (backup.mtime.getTime() >= cutoffMs) {
      continue;
    }
    unlinkSync(backup.path);
    if (existsSync(`${backup.path}.sha256`)) {
      unlinkSync(`${backup.path}.sha256`);
    }
    removed += 1;
  }

  logEvent("db.prune_backups", { backupDir: relativeToProject(config.backupDir), removed, retentionDays: config.backupRetentionDays });
  console.log(`Pruned ${removed} backup${removed === 1 ? "" : "s"} older than ${config.backupRetentionDays} days.`);
}

const [command = "help", ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const config = getRuntimeConfig();

try {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "init":
      await withTimedOperation("db.init", { dbFile: relativeToProject(config.dbFile) }, async () => {
        if (existsSync(config.dbFile) && !args.flags.has("force")) {
          console.log(`DB already exists: ${relativeToProject(config.dbFile)}`);
          console.log("Run migrate/status/backup, or pass --force to reinitialize after taking an automatic pre-init backup.");
          return;
        }
        if (existsSync(config.dbFile) && args.flags.has("force")) {
          await createBackup(config, { label: "pre-init", silent: true });
        }
        ensureDir(path.dirname(config.dbFile));
        writeJsonFileAtomic(config.dbFile, emptyDatabase());
        const result = await migrateDatabase(config, { createIfMissing: true, backupBeforeMigrate: false });
        console.log(`DB initialized: ${relativeToProject(config.dbFile)} (schema v${result.db.schemaVersion})`);
      });
      break;
    case "migrate":
      await withTimedOperation("db.migrate", { dbFile: relativeToProject(config.dbFile) }, async () => {
        const result = await migrateDatabase(config, { createIfMissing: true, backupBeforeMigrate: true });
        if (result.applied.length === 0) {
          console.log("No pending migrations.");
        } else {
          console.log(`Applied migrations: ${result.applied.map((migration) => migration.id).join(", ")}`);
        }
        console.log(`Schema version: ${result.db.schemaVersion}`);
      });
      break;
    case "status":
      await printStatus(config);
      break;
    case "verify":
      await withTimedOperation("db.verify", { dbFile: relativeToProject(config.dbFile) }, async () => verifyDatabase(config));
      break;
    case "backup":
      await withTimedOperation("db.backup_command", { dbFile: relativeToProject(config.dbFile) }, async () => {
        await createBackup(config, { label: args.values.get("label") ?? "" });
      });
      break;
    case "restore":
      if (!args.flags.has("yes")) {
        throw new Error("Restore is intentionally guarded. Re-run with --yes after confirming the backup file.");
      }
      if (!args.positional[0]) {
        throw new Error("Missing backup file path.");
      }
      await withTimedOperation("db.restore_command", { dbFile: relativeToProject(config.dbFile) }, async () => restoreBackup(config, args.positional[0]));
      break;
    case "prune-backups":
      pruneBackups(config);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
