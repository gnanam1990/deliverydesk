import { loadConfig } from '../config.ts';
import { openDb } from '../db/db.ts';
import { currentVersion } from '../db/migrate.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
console.log(`[deliverydesk] schema version: ${currentVersion(db)}`);
db.close();
