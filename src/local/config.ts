// Where the local runtime keeps data, and which kind of instance this is.
//
//   personal  ~/Library/Application Support/CareerAtlas      (npm run start:local, the Mac launcher)
//   dev       <repo>/.dev-data                                (npm run dev; synthetic data)
//   test      a temporary directory per test run
//
// The personal database is never inside the repository, `node_modules/` or `dist/`.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type InstanceKind = "personal" | "dev" | "test";

export interface LocalConfig {
  kind: InstanceKind;
  appRoot: string;
  dataDir: string;
  dbPath: string;
  documentsDir: string;
  logsDir: string;
  backupDir: string;
  host: string;
  port: number;
  /** Settings persisted in <dataDir>/config.json (never in the repository). */
  settings: LocalSettings;
}

export interface LocalSettings {
  /** Identity of the single local user (set by the Preview → local migration; never committed). */
  owner_email?: string;
  /** "claude_code" enables optional AI extraction through the local Claude Code CLI. */
  ai_provider?: "none" | "claude_code";
  /** Workday accounts: password for NEW accounts — "unique" (generated per employer, default) or "shared" (the user's own, in the Keychain). */
  workday_password_mode?: "unique" | "shared";
  /** Workday: sign in automatically when a Keychain credential exists for the employer site (default on). */
  workday_auto_sign_in?: boolean;
  /** Absolute path to the `claude` executable (auto-detected when unset). */
  claude_path?: string;
  claude_model?: string;
  /** Weekly backups: number of recovery points to keep. */
  backup_keep?: number;
  backup_interval_days?: number;
  /** Set once the personal database has been created; a missing DB file is then an error, never silently recreated. */
  db_created_at?: string;
}

export const DEFAULT_PORT = 4310;

/** Repository / install root (works from src/local and from the bundled dist/server). */
export function findAppRoot(from = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "migrations"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Cannot locate the Career Atlas installation (package.json + migrations/)");
}

export function personalDataDir() {
  return join(homedir(), "Library", "Application Support", "CareerAtlas");
}

const FORBIDDEN_SEGMENTS = [`${sep}node_modules${sep}`, `${sep}.wrangler${sep}`, `${sep}dist${sep}`];

/** The personal database must live outside the repository and outside disposable build/dev folders. */
export function assertSafePersonalDir(dataDir: string, appRoot: string) {
  const d = resolve(dataDir) + sep;
  const root = resolve(appRoot) + sep;
  if (d.startsWith(root)) throw new Error(`Refusing to keep personal data inside the source directory (${dataDir}).`);
  if (FORBIDDEN_SEGMENTS.some((s) => d.includes(s))) throw new Error(`Refusing to keep personal data in a disposable directory (${dataDir}).`);
}

export function loadConfig(overrides: { kind?: InstanceKind; dataDir?: string; port?: number } = {}): LocalConfig {
  const appRoot = findAppRoot();
  const kind: InstanceKind = overrides.kind ?? (process.env.CAREER_ATLAS_INSTANCE as InstanceKind) ?? "personal";
  if (!["personal", "dev", "test"].includes(kind)) throw new Error(`Unknown CAREER_ATLAS_INSTANCE "${kind}"`);
  const dataDir = resolve(
    overrides.dataDir ?? process.env.CAREER_ATLAS_DATA_DIR ?? (kind === "personal" ? personalDataDir() : kind === "dev" ? join(appRoot, ".dev-data") : ""),
  );
  if (!dataDir || dataDir === resolve("")) throw new Error("A data directory is required for test instances");
  if (kind === "personal") assertSafePersonalDir(dataDir, appRoot);
  // Dev, demo and test instances can never open the personal data folder (no reset/reseed/test by accident).
  if (kind !== "personal" && (dataDir + sep).startsWith(resolve(personalDataDir()) + sep)) {
    throw new Error(`Refusing to use the personal data folder for a ${kind} instance (${dataDir}).`);
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const settings = readSettings(dataDir);
  const port = overrides.port ?? (Number(process.env.CAREER_ATLAS_PORT) || (kind === "dev" ? 8788 : DEFAULT_PORT));
  return {
    kind,
    appRoot,
    dataDir,
    dbPath: join(dataDir, kind === "personal" ? "career-atlas.sqlite" : `career-atlas-${kind}.sqlite`),
    documentsDir: join(dataDir, "documents"),
    logsDir: join(dataDir, "logs"),
    // Only the personal instance writes to ~/CareerAtlasBackups; dev/test instances never mix their
    // synthetic backups into the real backup folder.
    backupDir: resolve(process.env.CA_BACKUP_DIR ?? (kind === "personal" ? join(homedir(), "CareerAtlasBackups") : join(tmpdir(), `career-atlas-${kind}-backups`))),
    host: "127.0.0.1",
    port,
    settings,
  };
}

export function readSettings(dataDir: string): LocalSettings {
  const file = join(dataDir, "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LocalSettings;
  } catch {
    throw new Error(`${file} is not valid JSON. Fix or remove it (your data is in the .sqlite file, not here).`);
  }
}

/** Atomic write (temp file + rename) so a crash never leaves a half-written config. */
export function writeSettings(cfg: LocalConfig, patch: Partial<LocalSettings>) {
  cfg.settings = { ...cfg.settings, ...patch };
  const file = join(cfg.dataDir, "config.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(cfg.settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
