-- Corporate Moneypenny (MNP) schema. SQLite / Cloudflare D1 compatible.
-- Amounts are whole integers. 1 credit = 1 cent when 100 credits = US$1.
-- Times are milliseconds since epoch.

CREATE TABLE tenant (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at INTEGER NOT NULL
);

CREATE TABLE tenant_setting (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

-- Only the key id lives here. The signing secret is derived from MNP_MASTER_SECRET (never stored).
CREATE TABLE api_key (
  key_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  scope TEXT NOT NULL CHECK (scope IN ('api','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  label TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE nonce (
  key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (key_id, nonce)
);

CREATE TABLE rate_limit (
  key_id TEXT NOT NULL,
  window INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (key_id, window)
);

CREATE TABLE idempotency (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  req_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE account (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  email_norm TEXT NOT NULL,
  email_canon TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
  first_paid_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, email_norm)
);
CREATE INDEX account_canon ON account (tenant_id, email_canon);

-- A lot is one pile of credits in one hidden bucket. Balance = sum of unexpired lots.
CREATE TABLE lot (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  account_id TEXT NOT NULL REFERENCES account(id),
  bucket TEXT NOT NULL CHECK (bucket IN ('bought','bonus','commission')),
  original INTEGER NOT NULL CHECK (original > 0),
  remaining INTEGER NOT NULL CHECK (remaining >= 0 AND remaining <= original),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  eligible_at INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('purchase','rule','manual','commission','reinstate')),
  source_ref TEXT,
  rule_id TEXT,
  paid_minor INTEGER,
  currency TEXT,
  refunded_minor INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX lot_account ON lot (tenant_id, account_id, bucket);
CREATE UNIQUE INDEX lot_source_unique ON lot (tenant_id, source, source_ref) WHERE source_ref IS NOT NULL;

-- Append-only, hash-chained ledger (one chain per tenant).
CREATE TABLE entry (
  tenant_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT,
  lot_id TEXT,
  idem TEXT,
  meta TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX entry_account ON entry (tenant_id, account_id, seq);
CREATE TRIGGER entry_no_update BEFORE UPDATE ON entry BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER entry_no_delete BEFORE DELETE ON entry BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

CREATE TABLE hold (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  order_ref TEXT NOT NULL,
  order_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  credits INTEGER NOT NULL,
  credit_value_minor INTEGER NOT NULL,
  cash_due_minor INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held','captured','released')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  closed_at INTEGER,
  payment_ref TEXT,
  refunded_credits INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX hold_open_order ON hold (tenant_id, order_ref) WHERE status = 'held';
CREATE UNIQUE INDEX hold_payment_ref ON hold (tenant_id, payment_ref) WHERE payment_ref IS NOT NULL;

CREATE TABLE hold_part (
  hold_id TEXT NOT NULL REFERENCES hold(id),
  lot_id TEXT NOT NULL REFERENCES lot(id),
  bucket TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  refunded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hold_id, lot_id)
);

CREATE TABLE earning_rule (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  event_type TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('bonus','commission')),
  amount_type TEXT NOT NULL CHECK (amount_type IN ('fixed','pct_cash_bps')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  mode TEXT NOT NULL CHECK (mode IN ('once','capped','every')),
  max_count INTEGER,
  lifetime_cap INTEGER,
  expiry_days INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, event_type)
);

CREATE TABLE event_in (
  tenant_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  email_canon TEXT NOT NULL,
  account_id TEXT,
  rule_id TEXT,
  bucket TEXT,
  granted INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, event_key)
);
CREATE INDEX event_canon ON event_in (tenant_id, email_canon, created_at);

CREATE TABLE conversion_request (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested')),
  terms TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  tenant_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TABLE webhook_endpoint (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at INTEGER NOT NULL
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX outbox_due ON outbox (status, next_at);
