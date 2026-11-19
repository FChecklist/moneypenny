// Applies migration files. No Node-only imports, so the Cloudflare Worker can use it too.
export function migrateFiles(db, files) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (file TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const has = (t) => db.raw.prepare("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const done = new Set(db.raw.prepare('SELECT file FROM schema_migrations').all().map((r) => r.file));
  // a database made before this table existed: work out what it already has
  if (!done.size && has('tenant')) {
    for (const [f, probe] of [['0001_init.sql', 'tenant'], ['0002_gate_fx.sql', 'fx_rate'], ['0003_ai_safety.sql', 'approval_request']]) if (has(probe)) done.add(f);
    for (const f of done) db.raw.prepare('INSERT INTO schema_migrations (file, applied_at) VALUES (?, ?)').run(f, Date.now());
  }
  for (const [f, sql] of files) {
    if (done.has(f)) continue;
    if (db.raw.exec) {
      // one transaction per file: it is applied completely or not at all
      db.raw.exec('BEGIN');
      try {
        db.raw.exec(sql);
        db.raw.prepare('INSERT INTO schema_migrations (file, applied_at) VALUES (?, ?)').run(f, Date.now());
        db.raw.exec('COMMIT');
      } catch (e) {
        db.raw.exec('ROLLBACK');
        throw e;
      }
    } else {
      db.exec(sql); // Durable Object: the caller wraps migrate() in storage.transactionSync
      db.raw.prepare('INSERT INTO schema_migrations (file, applied_at) VALUES (?, ?)').run(f, Date.now());
    }
  }
}
