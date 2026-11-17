// Local dev server (one light Node process). Reads .dev.vars and .data/dev.sqlite.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { createApp } from '../src/api.js';

const vars = Object.fromEntries(readFileSync('.dev.vars', 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')));
const app = createApp({ db: openDb('.data/dev.sqlite'), master: vars.MNP_MASTER_SECRET });
const port = Number(process.env.PORT || 8787);

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const r = await app.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log(`Moneypenny (local) on http://localhost:${port}`));
