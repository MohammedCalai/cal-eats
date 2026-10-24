import { loadConfig } from "../config.js";
import { closeDatabase, migrateDatabase, openDatabase } from "../db/index.js";
import { seedDemoData } from "../seed.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
try {
  migrateDatabase(db);
  const result = await seedDemoData(db);
  console.log(`Local demo data ready (${result.accounts} accounts). Credentials are documented in README.md.`);
} finally { closeDatabase(db); }
