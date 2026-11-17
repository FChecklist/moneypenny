// Seeds the one 'demo' tenant with starter rules. Starter numbers, all editable in the database.
import { createTenant, createRule } from './admin.js';
import { setCatalogue } from './gate.js';

export const DEMO_RULES = [
  { event_type: 'account_created', bucket: 'bonus', amount: 100, mode: 'once' },
  { event_type: 'first_game_created', bucket: 'bonus', amount: 200, mode: 'once' },
  { event_type: 'first_game_paid', bucket: 'bonus', amount: 200, mode: 'once' },
  { event_type: 'first_game_completed', bucket: 'bonus', amount: 200, mode: 'once' },
  // Commission is a percent (in basis points) of CASH actually received; 1000 = 10%. Placeholder for the demo only.
  { event_type: 'referral_sale_paid', bucket: 'commission', amount_type: 'pct_cash_bps', amount: 1000, mode: 'every' },
];

export async function seedDemo(ctx) {
  const t = await createTenant(ctx, { id: 'demo', name: 'Demo' });
  const c = { ...ctx, tenantId: 'demo', actor: 'owner-cli', callerType: 'owner', _settings: null };
  for (const r of DEMO_RULES) await createRule(c, r);
  await setCatalogue(c, { product: 'demo_product', item: 'sample_item', credits: 500 }); // a sample price, in credits
  return t;
}
