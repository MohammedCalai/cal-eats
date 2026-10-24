import { loadConfig } from "../config.js";
import { closeDatabase, migrateDatabase, openDatabase } from "../db/index.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
try { console.log(`Applied database migrations through version ${migrateDatabase(db)}`); }
finally { closeDatabase(db); }
