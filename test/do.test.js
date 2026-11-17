// The Durable Object adapter (do.js), run against a stand-in for its storage.
// This proves our adapter's logic: all-or-nothing, one request at a time, same answers as the local database.
// It does not prove Cloudflare's runtime: that needs a deployed check (see README, "What is not tested").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doDb } from '../src/do.js';
import { migrate, readMigrationFiles } from '../src/db.js';
import { MIGRATIONS } from '../src/migrations.gen.js';
import { fakeStorage } from './do-storage.js';

test('the bundled migrations are exactly the migration files', () => {
  assert.deepEqual(MIGRATIONS, readMigrationFiles());
});

test('a failing request leaves nothing behind (all or nothing)', async () => {
  const db = doDb(fakeStorage());
  migrate(db, MIGRATIONS);
  await db.run("INSERT INTO tenant (id, name, created_at) VALUES ('t1','One',1)");
  await assert.rejects(db.tx(async (t) => {
    await t.run("INSERT INTO tenant (id, name, created_at) VALUES ('t2','Two',1)");
    throw new Error('boom');
  }), /boom/);
  assert.equal((await db.first("SELECT COUNT(*) n FROM tenant WHERE id = 't2'")).n, 0);
  assert.equal((await db.first("SELECT COUNT(*) n FROM tenant WHERE id = 't1'")).n, 1);
});

test('two requests never interleave, even when one waits on the network inside its transaction', async () => {
  const db = doDb(fakeStorage());
  migrate(db, MIGRATIONS);
  await db.run("INSERT INTO tenant (id, name, created_at) VALUES ('t1','One',1)");
  const log = [];
  const slow = db.tx(async (t) => {
    log.push('a-start');
    await new Promise((r) => setTimeout(r, 30)); // a rail call
    await t.run("UPDATE tenant SET name = 'A' WHERE id = 't1'");
    log.push('a-end');
  });
  const fast = db.tx(async (t) => {
    log.push('b-start');
    const row = await t.first("SELECT name FROM tenant WHERE id = 't1'");
    log.push(`b-saw-${row.name}`);
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(log, ['a-start', 'a-end', 'b-start', 'b-saw-A']);
});

test('migrations run once, also on this adapter', async () => {
  const db = doDb(fakeStorage());
  migrate(db, MIGRATIONS);
  migrate(db, MIGRATIONS);
  assert.equal((await db.first('SELECT COUNT(*) n FROM schema_migrations')).n, MIGRATIONS.length);
});

test('a nested transaction joins the outer one', async () => {
  const db = doDb(fakeStorage());
  migrate(db, MIGRATIONS);
  await assert.rejects(db.tx(async (t) => {
    await t.tx(async (u) => u.run("INSERT INTO tenant (id, name, created_at) VALUES ('t3','Three',1)"));
    throw new Error('late');
  }));
  assert.equal((await db.first("SELECT COUNT(*) n FROM tenant WHERE id = 't3'")).n, 0);
});
