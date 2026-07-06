-- Reference schema for the `dealer-portal` D1 database (de115c9b-2be3-44b0-a359-d9fb9402b667).
-- This documents the CURRENT LIVE schema after migrate-dealer-portal.sql was applied
-- on top of tables that predated this Worker. It is not meant to be run directly against
-- an existing database — use migrate-dealer-portal.sql for that. It's here so a from-scratch
-- deploy (e.g. a new environment) can recreate the same shape in one shot.

CREATE TABLE dealers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dealership_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'dealer',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE dealer_sessions (
  id TEXT PRIMARY KEY,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE inventory_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  trim TEXT,
  mileage INTEGER,
  asking_price INTEGER,
  category TEXT,
  description TEXT,
  image_url TEXT,
  image_urls TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sell_my_car_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  zip TEXT,
  year INTEGER,
  make TEXT,
  model TEXT,
  trim TEXT,
  mileage INTEGER,
  vin TEXT,
  exterior_color TEXT,
  condition TEXT,
  title_status TEXT,
  remaining_balance TEXT,
  payoff_amount TEXT,
  accidents TEXT,
  accidents_count TEXT,
  accidents_damage TEXT,
  mechanical_issues TEXT,
  mechanical_desc TEXT,
  warning_lights TEXT,
  windshield TEXT,
  tires TEXT,
  modifications TEXT,
  modifications_desc TEXT,
  keys TEXT,
  timeline TEXT,
  city TEXT,
  state TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE find_car_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  zip TEXT,
  vehicle_type TEXT,
  size_preference TEXT,
  condition TEXT,
  budget_min TEXT,
  budget_max TEXT,
  timeline TEXT,
  priorities TEXT,
  current_vehicle TEXT,
  current_like TEXT,
  current_change TEXT,
  trade_in TEXT,
  specific_needs TEXT,
  considering TEXT,
  anything_else TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  topic TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lead_interest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES sell_my_car_leads(id) ON DELETE CASCADE,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(lead_id, dealer_id)
);

CREATE TABLE dealer_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  dealer_id INTEGER REFERENCES dealers(id)
);
