const Database = require('better-sqlite3');
const db = new Database('./data/iload.db');

console.log('🔄 Migrating database schema...');

try {
  // Check if model_type column exists
  const tableInfo = db.prepare("PRAGMA table_info(interconnector_models)").all();
  const hasModelType = tableInfo.some(col => col.name === 'model_type');
  
  if (!hasModelType) {
    console.log('  Adding model_type column...');
    db.prepare('ALTER TABLE interconnector_models ADD COLUMN model_type TEXT DEFAULT "regression"').run();
  }
  
  // Check if other new columns exist
  const hasR2 = tableInfo.some(col => col.name === 'r2_score');
  const hasMape = tableInfo.some(col => col.name === 'mape');
  const hasMae = tableInfo.some(col => col.name === 'mae');
  const hasRmse = tableInfo.some(col => col.name === 'rmse');
  const hasTrainingTime = tableInfo.some(col => col.name === 'training_time_ms');
  
  if (!hasR2) {
    console.log('  Adding r2_score column...');
    db.prepare('ALTER TABLE interconnector_models ADD COLUMN r2_score REAL').run();
  }
  if (!hasMape) {
    console.log('  Adding mape column...');
    db.prepare('ALTER TABLE interconnector_models ADD COLUMN mape REAL').run();
  }
  if (!hasMae) {
    console.log('  Adding mae column...');
    db.prepare('ALTER TABLE interconnector_models ADD COLUMN mae REAL').run();
  }
  if (!hasRmse) {
    console.log('  Adding rmse column...');
    db.prepare('ALTER TABLE interconnector_models ADD COLUMN rmse REAL').run();
  }
  if (!hasTrainingTime) {
    console.log('  Adding training_time_ms column...');
    db.prepare('ALTER TABLE interconnector_models ADD COLUMN training_time_ms INTEGER').run();
  }
  
  console.log('✅ Migration complete!');
} catch (error) {
  console.error('❌ Migration failed:', error.message);
  process.exit(1);
}

db.close();
