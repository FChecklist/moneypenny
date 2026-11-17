// Worker entry. All money requests go to ONE Durable Object (single writer, SQLite inside, atomic per request).
// NOT deployed in Phase 0. Needs the Cloudflare runtime ('cloudflare:workers'), so it is not imported by tests;
// the adapter it uses (do.js) is tested against a stand-in storage in test/do.test.js.
import { DurableObject } from 'cloudflare:workers';
import { createApp } from './api.js';
import { doDb } from './do.js';
import { migrate } from './db.js';
import { MIGRATIONS } from './migrations.gen.js';

export class MoneypennyDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.app = null;
    ctx.blockConcurrencyWhile(async () => {
      const db = doDb(ctx.storage);
      migrate(db, MIGRATIONS);
      this.app = createApp({ db, master: env.MNP_MASTER_SECRET });
    });
  }
  fetch(request) {
    return this.app.fetch(request);
  }
}

export default {
  fetch(request, env) {
    return env.MNP.get(env.MNP.idFromName('main')).fetch(request);
  },
};
