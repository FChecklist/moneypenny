// A stand-in for a Durable Object's SQLite storage (ctx.storage), built on node:sqlite.
// It follows the documented behaviour: sql.exec() runs a statement and returns a cursor; transaction(fn)
// runs fn and commits, or rolls back if it throws. It does NOT prove Cloudflare's runtime behaves the same.
import { DatabaseSync } from 'node:sqlite';

export function fakeStorage() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  let open = false;
  return {
    sql: {
      exec(sql, ...p) {
        if (!p.length && /;\s*\S/.test(sql)) { raw.exec(sql); return { toArray: () => [], rowsWritten: 0 }; }
        const st = raw.prepare(sql);
        if (st.columns().length) { const rows = st.all(...p); return { toArray: () => rows, rowsWritten: 0 }; }
        const r = st.run(...p);
        return { toArray: () => [], rowsWritten: Number(r.changes) };
      },
    },
    async transaction(fn) {
      if (open) throw new Error('nested transaction');
      raw.exec('BEGIN IMMEDIATE');
      open = true;
      try {
        const out = await fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      } finally {
        open = false;
      }
    },
  };
}
