// Prints the settings table for RULES.md straight from the schema, so docs cannot drift.
import { SCHEMA } from '../src/settings.js';

console.log('| Setting | Starting value | Meaning |\n|---|---|---|');
for (const [k, v] of Object.entries(SCHEMA)) console.log(`| \`${k}\` | \`${JSON.stringify(v.def)}\` | ${v.doc} |`);
