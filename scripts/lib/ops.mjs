import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(__dirname, "..", "..");

export function loadEnvFiles(root = projectRoot) {
  const loaded = [];
  for (const filename of [".env", ".env.local"]) {
    const filePath = path.join(root, filename);
    if (!existsSync(filePath)) {
      continue;
    }

    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const cleaned = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
      const equalsIndex = cleaned.indexOf("=");
      if (equalsIndex === -1) {
        continue;
      }

      const key = cleaned.slice(0, equalsIndex).trim();
      let value = cleaned.slice(equalsIndex + 1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        continue;
      }

      const quote = value[0];
      if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
        value = value.slice(1, -1);
      }

      if (process.env[key] === undefined) {
        process.env[key] = value;
        loaded.push({ key, file: filename });
      }
    }
  }
  return loaded;
}

export function parseInteger(value, fallback, { min = Number.NEGATIVE_INFINITY } = {}) {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function resolveProjectPath(value, fallback) {
  const candidate = value && value.trim() ? value.trim() : fallback;
  return path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
}

export function getRuntimeConfig() {
  loadEnvFiles();

  const dataDir = resolveProjectPath(process.env.FUNDX_DATA_DIR, "data");
  const primaryDbFile = resolveProjectPath(undefined, ".fundx/fundx-db.json");
  const fallbackDbFile = resolveProjectPath(undefined, path.join(dataDir, "fundx.db.json"));
  const configuredDbPath = process.env.FUNDX_DB_PATH || process.env.FUNDX_DB_FILE;
  const dbSelection = configuredDbPath
    ? { file: resolveProjectPath(configuredDbPath), source: process.env.FUNDX_DB_PATH ? "FUNDX_DB_PATH" : "FUNDX_DB_FILE" }
    : existsSync(primaryDbFile)
    ? { file: primaryDbFile, source: "primary .fundx/fundx-db.json" }
    : { file: fallbackDbFile, source: "fallback data/fundx.db.json" };

  return {
    appEnv: process.env.FUNDX_APP_ENV ?? process.env.NODE_ENV ?? "development",
    baseUrl: process.env.FUNDX_BASE_URL ?? "http://localhost:3000",
    dataDir,
    dbFile: dbSelection.file,
    dbFileSource: dbSelection.source,
    primaryDbFile,
    fallbackDbFile,
    backupDir: resolveProjectPath(process.env.FUNDX_BACKUP_DIR, "backups"),
    backupRetentionDays: parseInteger(process.env.FUNDX_BACKUP_RETENTION_DAYS, 14, { min: 1 }),
    logDir: resolveProjectPath(process.env.FUNDX_LOG_DIR, "logs"),
    logLevel: process.env.FUNDX_LOG_LEVEL ?? "info",
    runtimeDir: resolveProjectPath(process.env.FUNDX_RUNTIME_DIR, ".fundx-runtime"),
    slowQueryMs: parseInteger(process.env.FUNDX_SLOW_QUERY_MS, 500, { min: 1 }),
    jobHeartbeatMs: parseInteger(process.env.FUNDX_JOB_HEARTBEAT_MS, 15000, { min: 1000 }),
    jobStaleMs: parseInteger(process.env.FUNDX_JOB_STALE_MS, 300000, { min: 1000 }),
    healthMaxBackupAgeHours: parseInteger(process.env.FUNDX_HEALTH_MAX_BACKUP_AGE_HOURS, 24, { min: 1 }),
    requireRecentBackup: parseBoolean(process.env.FUNDX_REQUIRE_RECENT_BACKUP, false),
    marketDataProvider: process.env.FUNDX_MARKET_DATA_PROVIDER ?? "public-no-key"
  };
}

export function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

export function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeJsonFileAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

export function writeTextFileAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, value, "utf8");
  renameSync(tmpPath, filePath);
}

export function appendJsonLog(filePath, record) {
  ensureDir(path.dirname(filePath));
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export function logEvent(event, fields = {}) {
  const config = getRuntimeConfig();
  appendJsonLog(path.join(config.logDir, "ops.ndjson"), {
    ts: new Date().toISOString(),
    level: fields.level ?? "info",
    event,
    ...fields
  });
}

export async function withTimedOperation(event, fields, operation) {
  const config = getRuntimeConfig();
  const startedAt = performance.now();
  try {
    const result = await operation();
    const durationMs = Math.round(performance.now() - startedAt);
    logEvent(event, { ...fields, status: "ok", durationMs });
    if (durationMs >= config.slowQueryMs) {
      logEvent("slow_operation", { ...fields, sourceEvent: event, durationMs, thresholdMs: config.slowQueryMs, level: "warn" });
    }
    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    logEvent(event, {
      ...fields,
      status: "error",
      durationMs,
      level: "error",
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function relativeToProject(filePath) {
  const relative = path.relative(projectRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative || ".";
}

export function fileSha256(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function readDirSafe(dirPath) {
  if (!existsSync(dirPath)) {
    return [];
  }
  return readdirSync(dirPath);
}

export function fileInfo(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  const stats = statSync(filePath);
  return {
    path: filePath,
    size: stats.size,
    mtime: stats.mtime
  };
}
