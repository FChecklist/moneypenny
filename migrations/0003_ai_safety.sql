-- AI-ready safeguards: an AI key class, approvals for risky actions, caller type and key id on every audit entry.

-- Key classes: api (called "spend" in the contract), read, purchase, admin, ai_read.
ALTER TABLE api_key RENAME TO api_key_v1;
CREATE TABLE api_key (
  key_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  scope TEXT NOT NULL CHECK (scope IN ('api','read','purchase','admin','ai_read')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  label TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO api_key SELECT * FROM api_key_v1;
DROP TABLE api_key_v1;

-- Who did it: the key and what kind of caller it was (ai, product, payment, human, owner, system).
ALTER TABLE audit_log ADD COLUMN caller_type TEXT NOT NULL DEFAULT 'system';
ALTER TABLE audit_log ADD COLUMN key_id TEXT;

-- An AI key never moves credits or money itself. It asks; a person decides.
CREATE TABLE approval_request (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  action TEXT NOT NULL CHECK (action IN ('credit_spend','conversion','refund','payout','rate_change','price_change')),
  params TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  requested_by_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_by_key TEXT,
  decided_at INTEGER,
  result TEXT
);
CREATE INDEX approval_pending ON approval_request (tenant_id, status, created_at);

-- Payments the payment side has told us about (purchase key). A product can only capture the cash part of an
-- order against one of these, and a commission can only be paid on a payment we know.
CREATE TABLE verified_payment (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  ref TEXT NOT NULL,
  paid_minor INTEGER NOT NULL CHECK (paid_minor > 0),
  currency TEXT NOT NULL CHECK (currency IN ('INR','USD')),
  payer_canon TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, ref)
);

-- Which lots (and so which payments) a conversion took its credits from.
CREATE TABLE conversion_part (
  request_id TEXT NOT NULL REFERENCES conversion_request(id),
  lot_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  origin TEXT,
  PRIMARY KEY (request_id, lot_id)
);

-- How much commission earned on a payment has already been taken back by refunds (so repeated refunds never over- or under-reverse).
CREATE INDEX nonce_ts ON nonce (ts);

CREATE TABLE sale_reversal (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  ref TEXT NOT NULL,
  clawed INTEGER NOT NULL DEFAULT 0,   -- commission already taken back
  owed INTEGER NOT NULL DEFAULT 0,     -- commission a refund still claims but that is held, spent or in a conversion: it is never given back
  PRIMARY KEY (tenant_id, ref)
);
