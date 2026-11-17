// Owner tool: signs and sends one setup call to a deployed Moneypenny. The master secret is read from the
// MNP_MASTER_SECRET environment variable and is never printed or written anywhere.
// Usage:  MNP_MASTER_SECRET=... node scripts/setup.js https://your-host '{"action":"set_rate","rate":92,"reason":"first rate"}'
import { hmacHex } from '../src/util.js';

const [base, body] = process.argv.slice(2);
const master = process.env.MNP_MASTER_SECRET;
if (!base || !body || !master) {
  console.error('Need a base URL, a JSON body and MNP_MASTER_SECRET in the environment.');
  process.exit(1);
}
const ts = Date.now();
const sig = await hmacHex(master, `mnp-setup\n${ts}\n${body}`);
const r = await fetch(`${base.replace(/\/$/, '')}/v1/setup`, { method: 'POST', body, headers: { 'x-setup-ts': String(ts), 'x-setup-sig': sig } });
console.log(r.status, await r.text());
