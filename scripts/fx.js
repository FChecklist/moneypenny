// Owner tool for the daily exchange-rate table. Local only. The rate source is the built-in stub
// (no network): a real source is a Phase 1 adapter with the same fetch() shape.
//   node scripts/fx.js refresh      fetch today's rates (fixed for the UTC day)
//   node scripts/fx.js list         show recent rates
//   node scripts/fx.js approve <id> accept a rate held because it jumped too far
//   node scripts/fx.js reject <id>
import { openDb, migrate } from '../src/db.js';
import { refreshRates, approveRate, stubSource } from '../src/fx.js';

const db = openDb(process.env.MNP_DB || '.data/dev.sqlite');
migrate(db);
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'refresh') console.log(JSON.stringify(await refreshRates(db, stubSource, Date.now()), null, 2));
else if (cmd === 'approve' || cmd === 'reject') console.log(JSON.stringify(await approveRate(db, Number(arg), Date.now(), cmd === 'approve')));
else if (cmd === 'list') console.table(await db.all('SELECT id, currency, rate_x10000, source, status, datetime(valid_from/1000, \'unixepoch\') valid_from, note FROM fx_rate ORDER BY id DESC LIMIT 30'));
else console.log('Use: refresh | list | approve <id> | reject <id>');
