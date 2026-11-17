// Fails if a shipped file contains a word we must never ship (other people's trademarks, wrong wording).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN = ['monopoly', 'hasbro', 'fake money', 'play money', 'community chest', 'go to jail', 'pass go'];
const SKIP = new Set(['node_modules', '.git', '.data', 'test', 'scan-words.js']);

export function scan(root = '.') {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|json|md|sql|html|toml|txt)$/i.test(name) || name === 'LICENSE') {
        const text = readFileSync(p, 'utf8').toLowerCase();
        for (const w of FORBIDDEN) if (text.includes(w)) hits.push(`${p}: ${w}`);
      }
    }
  };
  walk(resolve(root));
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hits = scan('.');
  if (hits.length) {
    console.error('Forbidden words found:\n' + hits.join('\n'));
    process.exit(1);
  }
  console.log('Word scan clean.');
}
