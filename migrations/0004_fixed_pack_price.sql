-- An order for a listed INR pack keeps its fixed list price: it is never re-priced at a later exchange rate.
ALTER TABLE purchase_order ADD COLUMN fixed_price INTEGER NOT NULL DEFAULT 0;
