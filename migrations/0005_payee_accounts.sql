-- OWNER CHECKS BEFORE THIS RUNS ON PRODUCTION (both found by audit, neither can be settled from this repo):
-- 1. Mode. No table carries a test or demo marker (purchase_order and verified_payment have no such column, and
--    the tenant table has none). So every old order and payment is back-filled as 'live'. Check that no test-mode
--    order or payment exists in production. If one does, set its mode to 'test' by hand after this migration.
-- 2. Secret names. The Razorpay code is in the IT Services repo, not here, so the real secret NAMES are not known.
--    The legacy payee keeps secret_names '{}'. Until the owner sets the three real names, pause then activate on it
--    answers payee_secret_missing. Fill the names (names only, never values) before the registry is turned on.
-- Payee accounts: who receives the real money. A side record only. Credits, lots, entries, holds and the chain never read these tables.
CREATE TABLE payee_account (
  payee_id TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  gateway TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('test','live')),
  secret_names TEXT NOT NULL,            -- JSON of NAMES of platform secrets. Never a value.
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','retired')),
  currencies TEXT NOT NULL,              -- JSON list of INR / USD
  checkout TEXT NOT NULL DEFAULT '{}',   -- JSON: frame_origin, brand_name, description
  invoice TEXT NOT NULL DEFAULT '{}',    -- JSON: issuer and invoice text. Not secret.
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retired_at INTEGER,
  note TEXT
);

-- Which payee receives money for new orders of a product. Rows are never edited; only effective_to is set when a row is closed.
CREATE TABLE payee_route (
  route_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  product_id TEXT NOT NULL,              -- '*' means every product not routed otherwise
  payee_id TEXT NOT NULL REFERENCES payee_account(payee_id),
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  fallback_payee_id TEXT REFERENCES payee_account(payee_id),
  test_only INTEGER NOT NULL DEFAULT 0,
  set_by TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  change_id TEXT
);
CREATE INDEX payee_route_key ON payee_route (tenant_id, product_id, effective_from);

-- Two-step change: prepare, then confirm.
CREATE TABLE payee_change (
  change_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  confirm_phrase TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','confirmed','expired','rejected')),
  prepared_by TEXT NOT NULL,
  prepared_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  result TEXT
);

-- Owner-level hash chain (one chain, not per tenant).
CREATE TABLE payee_audit (
  seq INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  key_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  change_id TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

-- Gateway events seen per payee (repeat protection).
CREATE TABLE payee_event (
  payee_id TEXT NOT NULL REFERENCES payee_account(payee_id),
  event_id TEXT NOT NULL,
  type TEXT,
  order_id TEXT,
  outcome TEXT,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (payee_id, event_id)
);

-- A stored reconciliation run, so it can be repeated.
CREATE TABLE reconcile_run (
  run_id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL REFERENCES payee_account(payee_id),
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  inputs TEXT NOT NULL,
  result TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

ALTER TABLE purchase_order ADD COLUMN product TEXT;
ALTER TABLE purchase_order ADD COLUMN payee_id TEXT REFERENCES payee_account(payee_id);
ALTER TABLE purchase_order ADD COLUMN route_id TEXT;
ALTER TABLE purchase_order ADD COLUMN payee_version INTEGER;
ALTER TABLE purchase_order ADD COLUMN mode TEXT;
ALTER TABLE purchase_order ADD COLUMN payee_snapshot TEXT;
ALTER TABLE verified_payment ADD COLUMN payee_id TEXT REFERENCES payee_account(payee_id);
CREATE INDEX purchase_order_payee ON purchase_order (payee_id);

-- Back-fill: the payee that exists today. Secret names are not known here (see owner check 2), so none are recorded.
INSERT INTO payee_account (payee_id, legal_name, display_name, gateway, mode, secret_names, status, currencies, version, created_by, created_at, updated_at, note)
SELECT 'pay_legacy_itservices', 'IT Services by Rajat Agarwal', 'IT Services by Rajat Agarwal', 'razorpay', 'live', '{}', 'active', '["INR","USD"]', 1, 'migration', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000, 'Payee in use before payee accounts existed.'
WHERE NOT EXISTS (SELECT 1 FROM payee_account WHERE payee_id = 'pay_legacy_itservices');

UPDATE purchase_order SET payee_id = 'pay_legacy_itservices', payee_version = 1, mode = 'live' WHERE payee_id IS NULL;
UPDATE verified_payment SET payee_id = 'pay_legacy_itservices' WHERE payee_id IS NULL;

INSERT INTO payee_route (route_id, tenant_id, product_id, payee_id, effective_from, set_by, reason, created_at)
SELECT 'route_legacy_' || id, id, '*', 'pay_legacy_itservices', 0, 'migration', 'Back-fill: the payee in use before payee accounts existed.', CAST(strftime('%s','now') AS INTEGER) * 1000 FROM tenant WHERE NOT EXISTS (SELECT 1 FROM payee_route r WHERE r.route_id = 'route_legacy_' || tenant.id);
