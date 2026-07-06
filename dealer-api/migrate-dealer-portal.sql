-- Remove the broken test account (7-char "hash", no role/salt support)
DELETE FROM dealers WHERE email = 'jeff@theexactmatch.com';

-- Add role + salted-hash support
ALTER TABLE dealers ADD COLUMN role TEXT NOT NULL DEFAULT 'dealer';
ALTER TABLE dealers ADD COLUMN password_salt TEXT NOT NULL DEFAULT '';

-- Add fields the Submit Vehicle form needs
ALTER TABLE inventory_submissions ADD COLUMN category TEXT;
ALTER TABLE inventory_submissions ADD COLUMN image_urls TEXT;

-- Add fields the Sell Leads dealer view needs
ALTER TABLE sell_my_car_leads ADD COLUMN condition TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN title_status TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN city TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN state TEXT;

-- lead_interest currently points at inventory_submissions; dealers actually
-- express interest in sell leads. Table is empty, safe to drop/recreate.
DROP TABLE lead_interest;
CREATE TABLE lead_interest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES sell_my_car_leads(id) ON DELETE CASCADE,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(lead_id, dealer_id)
);
