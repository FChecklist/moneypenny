// The single description of every operation: plain words, read/write flag, MONEY flag, permission level,
// what an AI key may do with it, and which text in the answer was written by someone else (untrusted).
// `scripts/gen-contract.js` turns this into contract/v1/openapi.json; a test checks it matches the real routes.
//
// level: public | read | spend | purchase | admin | ai_ask
// rw:    read | write
// money: true when the call moves credits or money, or changes a price or rate
// ai:    'read' (an AI key may call it) | 'ask' (the AI route that only creates a request) | 'no'
export const OPS = [
  { id: 'health', method: 'GET', path: '/health', level: 'public', rw: 'read', money: false, ai: 'no', summary: 'Is the service working?', plain: 'Shows whether the database, the payment rail and the exchange rates are working. Shows no customer or tenant data. Needs no key.' },
  { id: 'getBalance', method: 'GET', path: '/v1/balance', level: 'read', rw: 'read', money: false, ai: 'read', untrusted: ['display.label', 'display.symbol', 'display.unit', 'display.text', 'display.convert_line', 'display.settling_line', 'display.terms_url', 'display.theme.name'], summary: 'Show one person\'s credit balance', plain: 'Returns what a person has, what is still settling, and ready-made text lines for a screen. If the database cannot answer, a balance seen a moment ago may be returned with degraded set to true.', errors: ['bad_email'] },
  { id: 'getQuote', method: 'GET', path: '/v1/quote', level: 'read', rw: 'read', money: false, ai: 'read', untrusted: ['currency_name', 'credits_text', 'display_text', 'currency_name'], summary: 'Price of some credits in dollars and rupees', plain: 'Shows what a number of credits is worth in US dollars and Indian rupees, and optionally a second currency for display only, with the time of the exchange rate used.', errors: ['bad_request'] },
  { id: 'getCatalogue', method: 'GET', path: '/v1/catalogue', level: 'read', rw: 'read', money: false, ai: 'read', untrusted: ['items[].product', 'items[].item'], summary: 'List what can be bought with credits', plain: 'The price list: each item and its price in credits.' },
  { id: 'getHistory', method: 'GET', path: '/v1/history', level: 'spend', rw: 'read', money: false, ai: 'read', untrusted: ['entries[].ref', 'entries[].ext_ref'], summary: 'A person\'s register entries', plain: 'Every movement of a person\'s credits, newest first, with the exchange rate locked at that moment.', errors: ['bad_email'] },
  { id: 'creditPurchase', method: 'POST', path: '/v1/credit_purchase', level: 'purchase', rw: 'write', money: true, ai: 'no', summary: 'Add bought credits after a verified payment', plain: 'The payment system calls this once a real payment is confirmed. The payment id works once. Credits cannot be more than the payment covers.', errors: ['amount_exceeds_payment', 'duplicate_ref', 'bad_request'] },
  { id: 'giveBonus', method: 'POST', path: '/v1/credit', level: 'spend', rw: 'write', money: true, ai: 'no', summary: 'Give a small free bonus by hand', plain: 'Gives a capped bonus to a person. The same limits as the earning rules apply, and it is recorded.', errors: ['cap_reached', 'blocked_domain', 'duplicate_ref', 'too_many_events', 'account_frozen'] },
  { id: 'sendEvent', method: 'POST', path: '/v1/event', level: 'spend', rw: 'write', money: true, ai: 'no', summary: 'Tell the system something happened that may earn credits', plain: 'The tenant\'s own rules decide whether an event earns anything. Commission needs the real payment id of the sale (sale_ref) and is paid once per sale.' },
  { id: 'reserveCash', method: 'POST', path: '/v1/spend/reserve', level: 'spend', rw: 'write', money: true, ai: 'no', summary: 'Set credits aside for a money order', plain: 'Holds credits against an order that may also need cash. Pay the cash due, then capture; or release.', errors: ['order_has_open_hold', 'rate_stale', 'bad_currency'] },
  { id: 'reserveItem', method: 'POST', path: '/v1/spend/reserve_item', level: 'spend', rw: 'write', money: true, ai: 'no', summary: 'Hold the credits for a priced item', plain: 'Holds the item\'s full price in credits, all or nothing. If there are not enough credits the answer is 402 with the shortfall.', errors: ['insufficient_credits', 'price_changed', 'no_item', 'order_has_open_hold', 'order_already_paid_with_credits', 'account_frozen'] },
  { id: 'captureHold', method: 'POST', path: '/v1/spend/capture', level: 'spend', rw: 'write', money: true, ai: 'no', summary: 'Finish a hold: the credits are spent', plain: 'Call after the product has delivered. If cash was due, send the payment id and the cash paid.', errors: ['hold_already_captured', 'hold_closed', 'hold_expired', 'underpaid', 'payment_reversed', 'no_hold', 'payment_not_verified', 'payment_reversed', 'payment_already_used'] },
  { id: 'releaseHold', method: 'POST', path: '/v1/spend/release', level: 'spend', rw: 'write', money: true, ai: 'no', summary: 'Give held credits back', plain: 'Cancels a hold and returns the credits. Safe to repeat.', errors: ['hold_already_captured', 'no_hold'] },
  { id: 'refund', method: 'POST', path: '/v1/refund', level: 'spend', rw: 'write', money: true, ai: 'no', summary: 'Return credits, note a money refund, or reverse a payment', plain: 'type order (product key) returns credits to where they came from. type purchase and chargeback need the payment key.', errors: ['wrong_key_type', 'nothing_to_return', 'more_than_spent', 'credits_already_used', 'no_purchase', 'refunds_off'] },
  { id: 'convertRequest', method: 'POST', path: '/v1/convert_request', level: 'spend', rw: 'write', money: true, ai: 'no', summary: 'Ask to turn commission credits into cash', plain: 'Off unless the tenant switches it on. It only calculates and records a request; it never pays.', errors: ['conversion_off', 'conversion_not_configured', 'below_minimum', 'more_than_convertible', 'account_frozen'] },
  { id: 'buyCredits', method: 'POST', path: '/v1/buy_credits', level: 'spend', rw: 'write', money: true, ai: 'no', summary: 'Start a purchase of credits', plain: 'Asks the payment side to open an order. Credits arrive only when the payment is confirmed. Repeating the same order_ref returns the same order.', errors: ['bad_currency', 'order_ref_used', 'rate_stale', 'bad_request'] },
  { id: 'paymentNotice', method: 'POST', path: '/v1/payment_notice', level: 'purchase', rw: 'write', money: true, ai: 'no', summary: 'The payment side notes a real payment', plain: 'Tells us a real payment happened (id, amount, currency). A product can then capture the cash part of an order, or earn a commission, only against a payment noted here (or one that bought credits). The same id with the same figures is a no-op.', errors: ['payment_conflict', 'bad_currency', 'bad_request'] },
  { id: 'confirmPayment', method: 'POST', path: '/v1/rail/confirm', level: 'purchase', rw: 'write', money: true, ai: 'no', summary: 'The payment side confirms a payment', plain: 'Credits are added at the rate the order was made at (inside the lock window) or re-priced (after it). The payment id works once.', errors: ['payment_mismatch', 'order_already_paid', 'no_order', 'duplicate_ref'] },
  { id: 'aiAsk', method: 'POST', path: '/v1/ai/ask', level: 'ai_ask', rw: 'write', money: false, ai: 'ask', summary: 'AI key: ask for something a person must approve', plain: 'Creates a pending request for one of: credit_spend, conversion, refund, payout, rate_change, price_change. Nothing is done until a person approves it in the admin area.', errors: ['action_not_askable', 'bad_ask', 'too_many_pending', 'ai_off'] },
  { id: 'aiApprovals', method: 'GET', path: '/v1/ai/approvals', level: 'ai_ask', rw: 'read', money: false, ai: 'read', untrusted: ['approvals[].params', 'approvals[].note'], summary: 'AI key: see its own requests and their answers', plain: 'Lists the requests this AI key made and whether a person approved or rejected them.' },
  { id: 'adminGetSettings', method: 'GET', path: '/v1/admin/settings', level: 'admin', rw: 'read', money: false, ai: 'no', summary: 'Read the tenant settings', plain: 'All numbers and wording the tenant can change.' },
  { id: 'adminSetSettings', method: 'PUT', path: '/v1/admin/settings', level: 'admin', rw: 'write', money: true, ai: 'no', summary: 'Change tenant settings', plain: 'Changes are recorded. Credits per dollar locks once credits exist.', errors: ['bad_setting', 'unknown_setting', 'rate_locked', 'rate_change_too_big'] },
  { id: 'adminListRules', method: 'GET', path: '/v1/admin/rules', level: 'admin', rw: 'read', money: false, ai: 'no', summary: 'List earning rules', plain: 'The tenant\'s rules for what earns credits.' },
  { id: 'adminCreateRule', method: 'POST', path: '/v1/admin/rules', level: 'admin', rw: 'write', money: true, ai: 'no', summary: 'Add an earning rule', plain: 'Commission can only be a percent of cash received. Plain visits can never earn.', errors: ['bad_rule', 'rule_exists', 'commission_needs_cash', 'cap_required', 'no_credit_for_visits'] },
  { id: 'adminUpdateRule', method: 'PUT', path: '/v1/admin/rules/{id}', level: 'admin', rw: 'write', money: true, ai: 'no', summary: 'Change an earning rule', plain: 'Same checks as adding a rule.', errors: ['bad_rule', 'no_rule'] },
  { id: 'adminDisableRule', method: 'DELETE', path: '/v1/admin/rules/{id}', level: 'admin', rw: 'write', money: true, ai: 'no', summary: 'Switch an earning rule off', plain: 'Rules are never deleted, only switched off.', errors: ['no_rule'] },
  { id: 'adminGetCatalogue', method: 'GET', path: '/v1/admin/catalogue', level: 'admin', rw: 'read', money: false, ai: 'no', summary: 'List all priced items', plain: 'Including switched-off items.' },
  { id: 'adminSetCatalogue', method: 'PUT', path: '/v1/admin/catalogue', level: 'admin', rw: 'write', money: true, ai: 'no', summary: 'Set the price of an item in credits', plain: 'Creates or changes one item. Recorded.', errors: ['bad_request'] },
  { id: 'adminAudit', method: 'GET', path: '/v1/admin/audit', level: 'admin', rw: 'read', money: false, ai: 'no', summary: 'The change log', plain: 'Every change with the key id and the kind of caller (ai, product, payment, human, owner, system).' },
  { id: 'adminHealth', method: 'GET', path: '/v1/admin/health', level: 'admin', rw: 'read', money: false, ai: 'no', summary: 'Integrity checks', plain: 'Ledger chain, audit chain, ledger-versus-balance check, rail, rates, dead letters.' },
  { id: 'adminReconcile', method: 'GET', path: '/v1/admin/reconcile', level: 'admin', rw: 'read', money: false, ai: 'read', summary: 'Credits owed, by bucket', plain: 'What is still owed in credits, what is held in orders, and conversions by status and currency. Numbers only. An AI key may read it.' },
  { id: 'adminListConversions', method: 'GET', path: '/v1/admin/conversions', level: 'admin', rw: 'read', money: false, ai: 'no', summary: 'Conversion requests', plain: 'Requests to turn commission into cash and where each stands.' },
  { id: 'adminConversionStep', method: 'POST', path: '/v1/admin/conversions/{id}/{step}', level: 'admin', rw: 'write', money: true, ai: 'no', summary: 'Move a conversion along: approve, instruct, mark_paid, reject', plain: 'A person approves, sends the instruction to the payment rail (a stub today), types the real payment id when paid, or rejects (only before it is sent).', errors: ['wrong_state', 'no_conversion', 'conversion_off'] },
  { id: 'adminSweep', method: 'POST', path: '/v1/admin/sweep', level: 'admin', rw: 'write', money: true, ai: 'no', summary: 'Housekeeping', plain: 'Gives back stale holds, ends expired credits, sends waiting rail calls, times out unpaid orders and old requests.' },
  { id: 'adminFreeze', method: 'POST', path: '/v1/admin/freeze', level: 'admin', rw: 'write', money: false, ai: 'no', summary: 'Pause or unpause a person', plain: 'A paused person cannot spend or earn.', errors: ['no_account'] },
  { id: 'adminAddWebhook', method: 'POST', path: '/v1/admin/webhooks', level: 'admin', rw: 'write', money: false, ai: 'no', summary: 'Add a webhook address', plain: 'Public https addresses only. The signing secret is shown once.', errors: ['bad_url'] },
  { id: 'adminDeadLetters', method: 'GET', path: '/v1/admin/dead_letters', level: 'admin', rw: 'read', money: false, ai: 'no', summary: 'Rail calls that failed too often', plain: 'Orders the payment rail would not take after 8 tries.' },
  { id: 'adminRequeueDeadLetter', method: 'POST', path: '/v1/admin/dead_letters/requeue', level: 'admin', rw: 'write', money: true, ai: 'no', summary: 'Try a dead letter again', plain: 'Use after the payment rail is fixed.', errors: ['no_dead_letter'] },
  { id: 'adminRailProcess', method: 'POST', path: '/v1/admin/rail/process', level: 'admin', rw: 'write', money: false, ai: 'no', summary: 'Send due rail calls now', plain: 'Normally done by the sweep.' },
  { id: 'adminListApprovals', method: 'GET', path: '/v1/admin/approvals', level: 'admin', rw: 'read', money: false, ai: 'no', summary: 'Requests waiting for a person', plain: 'What AI keys have asked for.' },
  { id: 'adminDecideApproval', method: 'POST', path: '/v1/admin/approvals/{id}/{decision}', level: 'admin', rw: 'write', money: true, ai: 'no', summary: 'Approve or reject a request', plain: 'Approve runs the asked action once, as the person who approved. Reject does nothing.', errors: ['no_approval', 'already_decided', 'approval_expired'] },
];

// ---- Documented answers of the payee routes (OpenAPI 3.0 schema objects). Written once here and copied into contract/v1/openapi.json by scripts/gen-contract.js.
// test/payee-contract.test.js calls every documented payee route and checks the real answer against these, so the file and the code cannot drift apart.
const str = { type: 'string' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const nul = (s) => ({ ...s, nullable: true });
const list = (items) => ({ type: 'array', items });
// OpenAPI 3.0.3 does not allow an empty `required` list, so it is left out when every property is optional (the contract test fails on an empty one).
const obj = (properties, optional = []) => {
  const required = Object.keys(properties).filter((k) => !optional.includes(k));
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
};
const sref = (name) => ({ $ref: `#/components/schemas/${name}` });
const yes = { type: 'boolean', enum: [true] };
const no = { type: 'boolean', enum: [false] };
const three = (s) => obj({ key_id: s, key_secret: s, webhook_secret: s });
export const SCHEMAS = {
  Error: { type: 'object', properties: { ok: no, error: { type: 'object', properties: { code: str, message: str }, required: ['code', 'message'] } }, required: ['ok', 'error'], additionalProperties: false },
  Payee: obj({
    payee_id: str, legal_name: str, display_name: str, gateway: str, mode: { type: 'string', enum: ['test', 'live'] },
    secret_names: obj({ key_id: str, key_secret: str, webhook_secret: str }, ['key_id', 'key_secret', 'webhook_secret']), // names only, never a value; empty until the owner fills them in
    status: { type: 'string', enum: ['draft', 'active', 'paused', 'retired'] }, currencies: list({ type: 'string', enum: ['INR', 'USD'] }),
    checkout: { type: 'object', additionalProperties: nul(str) }, invoice: { type: 'object', additionalProperties: nul(str) },
    version: int, created_by: str, created_at: int, updated_at: int, retired_at: nul(int), note: nul(str),
  }),
  PayeeHealth: obj({
    payee_id: str, display_name: str, gateway: str, mode: str, status: str,
    secrets: three(obj({ name: nul(str), present: bool })), secrets_ok: bool,
    last_webhook_at: nul(int), ignored_events: int, pending_rail_orders: int, oldest_pending_rail_at: nul(int),
  }),
  SecretCheck: obj({ ok: bool, payee_id: str, found: three(bool), missing: list(str) }), // ok is the result of the check; missing lists secret NAMES
  AuditEntry: { type: 'object', properties: { seq: int, ts: int, actor: str, key_id: nul(str), action: str, detail: { type: 'object' } }, required: ['seq', 'ts', 'actor', 'key_id', 'action', 'detail'], additionalProperties: false },
  AuditVerify: obj({ ok: bool, entries: int, broken_at: int }, ['entries', 'broken_at']), // ok true comes with entries; ok false comes with broken_at
  RouteSet: obj({ ok: yes, route_id: str, closed_route_id: nul(str) }),
  WebhookAnswer: obj({ ok: yes, result: str, order_id: str }, ['order_id']), // order_id only when result is recorded
  WebhookRetry: obj({ ok: no, result: str, retry: yes }),
};
const wrapped = (name, key) => obj({ ok: yes, [key]: sref(name) }); // { ok: true, <key>: <schema> }

// Owner calls (F6) and the payee webhook (F7). Not in OPS: they are not signed-key routes and have no tenant.
// Owner calls are signed with the master secret (headers x-owner-ts, x-owner-sig) and work only while MNP_PAYEE_ACCOUNTS is on.
// The webhook has no key at all: the gateway signature, checked with that payee's webhook secret, is the login.
// `answer` is the documented 200 answer (the webhook lists `answers` by status instead); `okIsResult` marks the two checks whose ok is the result of the check (a false answer is still HTTP 200).
const own = (id, method, path, rw, summary, plain, errors = [], extra = {}) => ({ id, method, path, level: 'owner', rw, money: false, ai: 'no', summary, plain, errors: ['payees_disabled', 'payee_forbidden', 'rate_limited', ...(method === 'GET' ? [] : ['bad_json']), 'replayed', 'forbidden', ...errors], ...extra });
export const OWNER_OPS = [
  own('ownerListPayees', 'GET', '/v1/owner/payees', 'read', 'List payees', 'Every payee with status, gateway, mode and the NAMES of its secrets. Never a secret value.', [], { answer: obj({ ok: yes, payees: list(sref('Payee')) }) }),
  own('ownerGetPayee', 'GET', '/v1/owner/payees/{id}', 'read', 'Read one payee', 'One payee record.', ['payee_not_found', 'not_found'], { answer: wrapped('Payee', 'payee') }),
  own('ownerCreatePayee', 'POST', '/v1/owner/payees', 'write', 'Add a payee as a draft', 'Secret NAMES only. A pasted secret value or a bank detail is refused.', ['bad_field', 'bad_gateway', 'bad_mode', 'bad_secret_names', 'bad_currencies', 'secret_value_refused', 'bank_detail_refused', 'payee_exists', 'payee_setup_incomplete'], { answer: wrapped('Payee', 'payee') }),
  own('ownerEditPayee', 'PUT', '/v1/owner/payees/{id}', 'write', 'Change a payee', 'Name, gateway, secret names and currencies lock after the first order.', ['payee_not_found', 'payee_retired', 'mode_fixed', 'identity_locked', 'payee_secret_missing', 'payee_setup_incomplete', 'bad_field', 'bad_gateway', 'bad_mode', 'bad_secret_names', 'bad_currencies', 'secret_value_refused', 'bank_detail_refused', 'payee_exists'], { answer: wrapped('Payee', 'payee') }),
  own('ownerPayeeStep', 'POST', '/v1/owner/payees/{id}/{step}', 'write', 'Activate, pause or retire a payee', 'step is activate (also resumes a paused payee), pause or retire.', ['payee_not_found', 'bad_transition', 'payee_secret_missing', 'payee_gateway_taken', 'payee_setup_incomplete'], { answer: wrapped('Payee', 'payee') }),
  own('ownerPayeeSecrets', 'GET', '/v1/owner/payees/{id}/secrets', 'read', 'Check which secret names are present', 'True or false for each name. Never a value. ok is the result of the check: true only when all three names are present. A false answer is still HTTP 200 and carries no error.', ['payee_not_found'], { answer: sref('SecretCheck'), okIsResult: true }),
  own('ownerPayeeHealth', 'GET', '/v1/owner/payees/{id}/health', 'read', 'Health of one payee', 'Gateway and mode, secret names with present true or false, last gateway event time, count of ignored events, orders waiting in pending_rail. Never a secret value. Writes nothing.', ['payee_not_found'], { answer: wrapped('PayeeHealth', 'health') }),
  own('ownerSetRoute', 'POST', '/v1/owner/routes', 'write', 'Set the payee for a product', 'Starts a new route row and closes the open one. Overlap is refused.', ['bad_field', 'bad_product', 'tenant_not_found', 'payee_not_found', 'payee_not_active', 'route_overlap', 'payee_setup_incomplete'], { answer: sref('RouteSet') }),
  own('ownerPayeeAudit', 'GET', '/v1/owner/payee_audit', 'read', 'The owner audit log of payees', 'Newest first. Ids and field names only.', ['bad_field'], { answer: obj({ ok: yes, entries: list(sref('AuditEntry')) }) }),
  own('ownerPayeeAuditVerify', 'GET', '/v1/owner/payee_audit/verify', 'read', 'Check the owner audit chain', 'Says ok or where the chain breaks. ok is the result of the check: false (with broken_at) when the chain is broken. A false answer is still HTTP 200 and carries no error.', [], { answer: sref('AuditVerify'), okIsResult: true }),
  { id: 'payeeWebhook', method: 'POST', path: '/v1/webhooks/payee/{id}', level: 'gateway', rw: 'write', money: true, ai: 'no', summary: 'Gateway event for one payee', plain: 'Signed by the gateway with that payee\'s webhook secret. A repeat answers duplicate: the same event id, and also the same payment id for an order already paid with it (nothing is stored then). An event for an unknown order or another payee is stored as ignored. Credits are given once, against the order\'s own payee. Final refusals (wrong currency, order already paid with another payment) are stored once as ignored and answer 200. A short amount or an order not yet awaiting payment answers 409 with retry true and the event id is not stored, so the gateway retries. Too many bad signatures from one source for one payee in a minute answer 429 for that source, and calls for a payee whose webhook secret is missing from the platform store are counted the same way (500, then 429); a good signature is never counted or refused.', errors: ['rate_limited', 'payees_disabled', 'payee_not_found', 'webhook_bad_signature', 'webhook_no_event_id', 'payee_secret_missing', 'too_large'], answers: { 200: sref('WebhookAnswer'), 409: sref('WebhookRetry') }, answerNotes: { 409: 'Not final: retry is true and the event id is not stored, so the gateway sends it again.' } },
];

const re = (p) => new RegExp('^' + p.replace(/\{[a-z_]+\}/g, '[A-Za-z0-9_]+') + '$');
const MATCHERS = OPS.map((o) => ({ o, re: re(o.path) }));
/** The operation for a real request, or null. */
export const opFor = (method, pathname) => MATCHERS.find((m) => m.o.method === method && m.re.test(pathname))?.o ?? null;

/** Key classes as named in the contract (the stored scope `api` is the class `spend`). */
export const CLASS_OF_SCOPE = { api: 'spend', read: 'read', purchase: 'purchase', admin: 'admin', ai_read: 'ai_read' };
