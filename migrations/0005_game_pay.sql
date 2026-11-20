-- Pay one specific game from credits, buying credits first when short (owner order 20 Nov 2026).
-- The game reference is the console's game id. One row per game: it is paid exactly once.

-- A credit order may belong to a game, and may be paid by someone other than the account (a pay link: the payee pays, the organizer is credited).
ALTER TABLE purchase_order ADD COLUMN game_ref TEXT;
ALTER TABLE purchase_order ADD COLUMN payer_email TEXT;   -- who must pay (lower-case); empty = the account's own e-mail
ALTER TABLE purchase_order ADD COLUMN payframe TEXT;      -- JSON the console hands to the payment window (from the rail)

CREATE TABLE game_pay (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  game_ref TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES account(id),   -- the organizer: credits are always taken from this account
  product TEXT NOT NULL,
  item TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),      -- the price the person was shown
  status TEXT NOT NULL CHECK (status IN ('open','paid','review')),
  reason TEXT,                                       -- why it is not paid yet (insufficient_credits, price_changed, ...)
  source TEXT NOT NULL CHECK (source IN ('console','paylink')),
  order_id TEXT,                                     -- the latest credit order made for this game
  hold_id TEXT,
  payment_ref TEXT,                                  -- the payment that completed it (if one was needed)
  event_id TEXT,                                     -- the signed event told to the game
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  paid_at INTEGER,
  PRIMARY KEY (tenant_id, game_ref)
);

-- A pay link: only the hash of the token is kept. The token itself is shown once.
CREATE TABLE game_pay_link (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  game_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX game_pay_link_game ON game_pay_link (tenant_id, game_ref);
CREATE INDEX purchase_order_game ON purchase_order (tenant_id, game_ref);
