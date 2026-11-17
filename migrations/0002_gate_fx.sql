-- Gate duty (catalogue, credit orders through a payment rail) and the FX rate table.

-- A sale used for commission counts once per tenant (separate from payments that bought credits).
-- (payment_ref.kind is free text from here on; the first migration's CHECK is replaced by a new table.)
ALTER TABLE payment_ref RENAME TO payment_ref_v1;
CREATE TABLE payment_ref (
  tenant_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('purchase','order','payout','sale')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, ref)
);
INSERT INTO payment_ref SELECT * FROM payment_ref_v1;
DROP TABLE payment_ref_v1;

-- Orders locked to the rate in force when they were created.
ALTER TABLE hold ADD COLUMN rate_cpu INTEGER;
ALTER TABLE hold ADD COLUMN rate_inr INTEGER;
ALTER TABLE hold ADD COLUMN product TEXT;
ALTER TABLE hold ADD COLUMN item TEXT;

-- Prices in credits, per tenant and product.
CREATE TABLE catalogue_item (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  product TEXT NOT NULL,
  item TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, product, item)
);

-- A person buys credits: we ask the payment rail for an order, and credit only when the payment is confirmed.
CREATE TABLE purchase_order (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  account_id TEXT NOT NULL REFERENCES account(id),
  order_ref TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  currency TEXT NOT NULL CHECK (currency IN ('INR','USD')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  rate_cpu INTEGER NOT NULL,
  rate_inr INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_rail','awaiting_payment','paid','failed')),
  rail_order_id TEXT,
  pay_url TEXT,
  payment_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, order_ref)
);

-- Calls to the payment rail wait here and are retried; after too many tries they become dead letters.
CREATE TABLE rail_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES purchase_order(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX rail_outbox_due ON rail_outbox (status, next_at);

-- Daily exchange rates (units of a currency per 1 US$). Append-only; shared by every tenant.
CREATE TABLE fx_rate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  currency TEXT NOT NULL,
  rate_x10000 INTEGER NOT NULL CHECK (rate_x10000 > 0),
  source TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER NOT NULL,
  margin_bps INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active','pending_approval','rejected')),
  note TEXT,
  resolves INTEGER            -- an approval or rejection row points at the held row it answers
);
CREATE UNIQUE INDEX fx_one_active_per_day ON fx_rate (currency, valid_from) WHERE status = 'active';
CREATE INDEX fx_lookup ON fx_rate (currency, status, valid_from);
CREATE TRIGGER fx_no_update BEFORE UPDATE ON fx_rate BEGIN SELECT RAISE(ABORT, 'rate history is append-only'); END;
CREATE TRIGGER fx_no_delete BEFORE DELETE ON fx_rate BEGIN SELECT RAISE(ABORT, 'rate history is append-only'); END;
