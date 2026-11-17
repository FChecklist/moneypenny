// Owner view: credits still owed (liability) by bucket and tenant, conversions pending/paid. Read-only.
import { openDb } from '../src/db.js';
import { reconcileAll } from '../src/reconcile.js';

const db = openDb(process.argv[2] || '.data/dev.sqlite');
console.log(JSON.stringify(await reconcileAll(db), null, 2));
