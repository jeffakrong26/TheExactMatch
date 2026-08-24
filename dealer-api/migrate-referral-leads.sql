-- Refer a Buyer form (theexactmatch.com/referral) has never had a backing
-- table or endpoint — see migrate-public-leads.sql for the sibling
-- contact_messages table this mirrors.
CREATE TABLE referral_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  zip TEXT,
  referred_by TEXT,
  preferred_make TEXT,
  preferred_model TEXT,
  year_min INTEGER,
  year_max INTEGER,
  budget_min INTEGER,
  budget_max INTEGER,
  timeline TEXT,
  anything_else TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
