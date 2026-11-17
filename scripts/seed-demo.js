// Creates .data/dev.sqlite with the 'demo' tenant and prints its keys ONCE. Local only.
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openDb, migrate } from '../src/db.js';
import { seedDemo } from '../src/seed.js';

mkdirSync('.data', { recursive: true });
if (existsSync('.data/dev.sqlite')) rmSync('.data/dev.sqlite');
const master = randomBytes(24).toString('hex');
writeFileSync('.dev.vars', `MNP_MASTER_SECRET=${master}\n`);
const db = openDb('.data/dev.sqlite');
migrate(db);
const out = await db.tx((t) => seedDemo({ db: t, now: Date.now, master }));
console.log('Demo tenant ready. Keep these; they are not shown again.');
console.log('API key id   :', out.api.key_id);
console.log('API secret   :', out.api.secret);
console.log('Admin key id :', out.admin.key_id);
console.log('Admin secret :', out.admin.secret);
console.log('Next: npm run dev   then open http://localhost:8787/admin');
