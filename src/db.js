// Database adapters. The app only ever sees: first / all / run / tx.
// Local harness: node:sqlite (in memory or a file). Cloudflare D1: see d1.js.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path = ':memory:') {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON');
  let lock = Promise.resolve();

  const make = (inTx) => {
    const h = {
      raw,
      async first(sql, ...p) {
        return raw.prepare(sql).get(...p) ?? null;
      },
      async all(sql, ...p) {
        return raw.prepare(sql).all(...p);
      },
      async run(sql, ...p) {
        const r = raw.prepare(sql).run(...p);
        return { changes: Number(r.changes) };
      },
      exec(sql) {
        raw.exec(sql);
      },
      // One transaction at a time; everything inside commits together or not at all.
      async tx(fn) {
        if (inTx) return fn(h);
        const prev = lock;
        let release;
        lock = new Promise((r) => (release = r));
        await prev;
        try {
          raw.exec('BEGIN IMMEDIATE');
          try {
            const out = await fn(txHandle);
            raw.exec('COMMIT');
            return out;
          } catch (e) {
            raw.exec('ROLLBACK');
            throw e;
          }
        } finally {
          release();
        }
      },
    };
    return h;
  };
  const txHandle = make(true);
  return make(false);
}

/** [name, sql] for every migration file, in order (Node only; a Worker uses the generated list). */
export function readMigrationFiles() {
  const dir = join(here, '..', 'migrations');
  return readdirSync(dir).filter((x) => x.endsWith('.sql')).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]);
}

export function migrate(db, files = readMigrationFiles()) {
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
