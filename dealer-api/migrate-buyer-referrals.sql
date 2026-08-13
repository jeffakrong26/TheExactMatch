-- Public intake for Max's exotic/luxury buyer referral network, submitted
-- at theexactmatch.com/referral. Deliberately separate from find_car_leads:
-- this is a curated, referral-based buyer list Max works personally, not
-- the general nationwide Find My Car pipeline.
CREATE TABLE buyer_referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  referred_by TEXT,
  zip TEXT,
  preferred_make TEXT,
  preferred_model TEXT,
  year_min INTEGER,
  year_max INTEGER,
  budget_min TEXT,
  budget_max TEXT,
  timeline TEXT,
  anything_else TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  admin_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Apply with:
--   npx wrangler d1 execute dealer-portal --remote --file=migrate-buyer-referrals.sql
