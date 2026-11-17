// Worker entry. All money requests go to ONE Durable Object (single writer, SQLite inside, atomic per request).
// NOT deployed in Phase 0. Needs the Cloudflare runtime ('cloudflare:workers'), so it is not imported by tests;
// the adapter it uses (do.js) is tested against a stand-in storage in test/do.test.js.
import { DurableObject } from 'cloudflare:workers';
import { unconfiguredRail } from './rail.js';
import { createApp } from './api.js';
import { doDb } from './do.js';
import { migrate } from './db.js';
import { MIGRATIONS } from './migrations.gen.js';
import { urlStatus } from './status.js';

export class MoneypennyDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.app = null;
    ctx.blockConcurrencyWhile(async () => {
      const db = doDb(ctx.storage);
      ctx.storage.transactionSync(() => migrate(db, MIGRATIONS)); // a half-applied migration is rolled back
      // MNP_STATUS_URL (a plain variable, not a secret) points at the Hub's status.json: the global off-switch
      this.app = createApp({ db, master: env.MNP_MASTER_SECRET, rail: unconfiguredRail, status: env.MNP_STATUS_URL ? urlStatus(env.MNP_STATUS_URL, { store: { get: () => ctx.storage.get('mnp_status'), set: (v) => ctx.storage.put('mnp_status', v) } }) : env.MNP_STATUS_OPTIONAL === '1' ? async () => ({ hub: { mode: 'on' } }) /* chosen on purpose: no global switch */ : async () => null /* no switch configured: changes stay shut */, requireRate: true });
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
