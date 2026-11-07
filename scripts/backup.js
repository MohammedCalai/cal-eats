import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BACKUP_ROOT = path.resolve(process.env.CALAI_BACKUP_DIR || path.join(PROJECT_ROOT, "backups"));
export const DEFAULT_SOURCE = path.resolve(process.env.CALAI_DB_PATH || path.join(PROJECT_ROOT, "data", "calai-eats.sqlite"));

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function timestampName(now = new Date()) {
  return `calai-eats-${now.toISOString().replace(/[:.]/g, "-")}.sqlite`;
}

export function resolveBackupDestination(destination, now = new Date()) {
  const resolved = path.resolve(destination ?? path.join(BACKUP_ROOT, timestampName(now)));
  if (!inside(BACKUP_ROOT, resolved) || path.dirname(resolved) !== BACKUP_ROOT || path.extname(resolved) !== ".sqlite") throw new Error(`Backup destination must be a direct-child .sqlite file inside ${BACKUP_ROOT}`);
  return resolved;
}

export async function createBackup({ source = DEFAULT_SOURCE, destination, now } = {}) {
  const sourcePath = path.resolve(source);
  const destinationPath = resolveBackupDestination(destination, now);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error(`Source database does not exist: ${sourcePath}`);
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const realBackupRoot = fs.realpathSync(BACKUP_ROOT);
  const realDestinationParent = fs.realpathSync(path.dirname(destinationPath));
  if (realDestinationParent !== realBackupRoot) throw new Error(`Backup destination parent escapes the managed backup directory: ${destinationPath}`);
  let reservation;
  let reservedIdentity;
  try {
    reservation = fs.openSync(destinationPath, "wx", 0o600);
    const reservedStat = fs.fstatSync(reservation, { bigint: true });
    reservedIdentity = { dev: reservedStat.dev, ino: reservedStat.ino };
    fs.closeSync(reservation);
    reservation = undefined;
  } catch (error) {
    if (reservation !== undefined) fs.closeSync(reservation);
    if (error?.code === "EEXIST") throw new Error(`Refusing to overwrite existing backup: ${destinationPath}`);
    throw error;
  }
  let db;
  try {
    db = new DatabaseSync(sourcePath, { readOnly: true });
    await sqliteBackup(db, destinationPath);
    // Temporary chats, phone-delivery registrations and customer app sessions
    // are excluded. A restored customer app must sign in and register again;
    // old alert or Live Activity delivery must not resume from the snapshot.
    // Formal order/dispute records and delivery revisions retain their policies.
    const copy = new DatabaseSync(destinationPath);
    try {
      // Delete delivery dependants before registrations, and registrations before
      // the native session they reference. This also works with older schemas.
      const temporaryTables = ["order_live_activity_outbox", "customer_order_live_activities", "customer_push_outbox", "customer_push_devices", "native_sessions", "order_messages", "order_message_reads", "order_message_rate_limits", "restaurant_customer_messages", "restaurant_customer_message_reads", "restaurant_customer_message_rate_limits"];
      const present = temporaryTables.filter(table => copy.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
      if (present.length) {
        copy.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; BEGIN IMMEDIATE;");
        try { for (const table of present) copy.exec(`DELETE FROM ${table}`); copy.exec("COMMIT"); }
        catch (error) { copy.exec("ROLLBACK"); throw error; }
        // Keep thread metadata and sequence high-watermarks; removing bodies
        // must not make later messages reuse an earlier ingestion sequence.
        copy.exec("VACUUM;");
      }
      if (copy.prepare("PRAGMA foreign_key_check").get()) throw new Error("Sanitized backup has a foreign key violation");
      const integrity = copy.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("Sanitized backup failed its integrity check");
    } finally { copy.close(); }
  } catch (error) {
    try {
      const current = fs.statSync(destinationPath, { bigint: true });
      if (current.dev === reservedIdentity.dev && current.ino === reservedIdentity.ino) fs.rmSync(destinationPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw error;
  } finally {
    db?.close();
  }
  return destinationPath;
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--source" && flag !== "--destination") throw new Error(`Unknown argument: ${flag}`);
    const value = args[++index];
    if (!value) throw new Error(`${flag} requires a path`);
    result[flag.slice(2)] = value;
  }
  return result;
}

async function main() {
  const destination = await createBackup(parseArgs(process.argv.slice(2)));
  console.log(`Backup created: ${destination}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`Backup failed: ${error.message}`); process.exitCode = 1; });
