// Durable Object database adapter: the one real way to run this on Cloudflare.
//
// Why a Durable Object and not D1: D1 has no interactive transactions, and every money request here is
// "read, decide, write several rows, all or nothing". A SQLite-backed Durable Object runs this same code
// next to its own database. Cloudflare documents that for SQLite-backed objects every ctx.storage.sql.exec()
// call made inside ctx.storage.transaction(async () => ...) is part of that transaction and is rolled back if
// the closure throws. On top of that we serialise requests ourselves (one transaction at a time), because a rail
// call (network) inside a transaction would otherwise let another request in.
//
// The adapter has the same shape as db.js (first / all / run / exec / tx) so no money code changes.
export function doDb(storage) {
  let lock = Promise.resolve();
  const rows = (sql, p) => storage.sql.exec(sql, ...p).toArray();
  const make = (inTx) => {
    const h = {
      async first(sql, ...p) { return rows(sql, p)[0] ?? null; },
      async all(sql, ...p) { return rows(sql, p); },
      async run(sql, ...p) { const c = storage.sql.exec(sql, ...p); c.toArray(); return { changes: Number(c.rowsWritten ?? 0) }; },
      exec(sql) { storage.sql.exec(sql).toArray(); },
      // used by migrate(): a tiny prepared-statement look-alike
      raw: {
        prepare: (sql) => ({
          get: (...p) => rows(sql, p)[0],
          all: (...p) => rows(sql, p),
          run: (...p) => { storage.sql.exec(sql, ...p).toArray(); },
        }),
      },
      async tx(fn) {
        if (inTx) return fn(h);
        const prev = lock;
        let release;
        lock = new Promise((r) => (release = r));
        await prev;
        try {
          return await storage.transaction(() => fn(txHandle)); // throws inside = rolled back
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
