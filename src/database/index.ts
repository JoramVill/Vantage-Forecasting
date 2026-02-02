// Database module exports
export { DatabaseService, getDatabase, closeDatabase, getZonalDatabase, closeZonalDatabase } from './database.js';
export type { DatabaseStats, StoredModel } from './database.js';
export { SCHEMA_VERSION, CREATE_TABLES_SQL, REGION_MAPPING } from './schema.js';
