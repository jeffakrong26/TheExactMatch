-- Max Motors wholesale flow: submissions aren't all newsletter/Highlights
-- candidates. `visibility` on inventory_submissions controls the audience;
-- `default_submission_visibility` on dealers seeds it per-dealer at submit
-- time (NULL behaves exactly like 'highlights', today's only behavior).
ALTER TABLE inventory_submissions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'highlights';
ALTER TABLE dealers ADD COLUMN default_submission_visibility TEXT;

-- Mirrors lead_interest (schema.sql:137) but against inventory_submissions
-- instead of sell_my_car_leads, for the new "Network Inventory" dealer tab.
CREATE TABLE submission_interest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES inventory_submissions(id) ON DELETE CASCADE,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  offer_amount INTEGER,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(submission_id, dealer_id)
);

-- Max Motors (wholesale) — his submissions default to private, not Highlights.
UPDATE dealers SET default_submission_visibility = 'private' WHERE id = 11;
