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

export function migrate(db) {
  const dir = join(here, '..', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
}
