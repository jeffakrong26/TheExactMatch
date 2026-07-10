-- Reference schema for the `dealer-portal` D1 database (de115c9b-2be3-44b0-a359-d9fb9402b667).
-- This documents the CURRENT LIVE schema after migrate-dealer-portal.sql was applied
-- on top of tables that predated this Worker. It is not meant to be run directly against
-- an existing database — use migrate-dealer-portal.sql for that. It's here so a from-scratch
-- deploy (e.g. a new environment) can recreate the same shape in one shot.

CREATE TABLE dealers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dealership_name TEXT NOT NULL,
  dealership_website TEXT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'dealer',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  autodev_dealer_id TEXT
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
  vin TEXT,
  exterior_color TEXT,
  engine TEXT,
  transmission TEXT,
  category TEXT,
  description TEXT,
  write_up TEXT,
  listing_url TEXT,
  image_url TEXT,
  image_urls TEXT,
  photo_url TEXT,
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
  payment_method TEXT,
  credit_range TEXT,
  desired_monthly_min TEXT,
  desired_monthly_max TEXT,
  down_payment TEXT,
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

CREATE TABLE admin_seen_items (
  section TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (section, item_id)
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

CREATE TABLE find_car_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_code TEXT NOT NULL UNIQUE,
  find_lead_id INTEGER NOT NULL REFERENCES find_car_leads(id),
  status TEXT NOT NULL DEFAULT 'pending_approval',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT
);

-- Sell My Car automation: valuation pipeline (VIN decode, Marketcheck comps,
-- Claude synthesis, photo-confirmed re-valuation). One row per sell_my_car_leads lead.
-- `token` is the unique tokenized link sent in Brevo email #1 for photo upload.
CREATE TABLE vehicle_valuations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES sell_my_car_leads(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,

  vin TEXT,
  decoded_year INTEGER,
  decoded_make TEXT,
  decoded_model TEXT,
  decoded_trim TEXT,
  decoded_engine TEXT,
  decoded_drivetrain TEXT,
  decoded_body_type TEXT,
  decode_raw TEXT,

  mileage INTEGER,

  title_status TEXT,
  accident_history TEXT NOT NULL DEFAULT 'none',
  accident_notes TEXT,
  general_condition TEXT,
  mechanical_status TEXT,
  mechanical_notes TEXT,

  marketcheck_comps TEXT,
  marketcheck_log TEXT,

  final_retail_value INTEGER,
  final_cash_value INTEGER,
  final_trade_in_value INTEGER,
  final_private_sale_value INTEGER,
  valuation_reasoning TEXT,
  valuation_breakdown TEXT,
  low_confidence INTEGER NOT NULL DEFAULT 0,

  manually_adjusted INTEGER NOT NULL DEFAULT 0,
  manually_adjusted_at TEXT,
  manually_adjusted_by TEXT,

  ai_condition_score TEXT,
  photo_confirmed INTEGER NOT NULL DEFAULT 0,
  photos_uploaded_at TEXT,

  status TEXT NOT NULL DEFAULT 'pending_photos',
  customer_notified_at TEXT,
  ready_to_sell INTEGER NOT NULL DEFAULT 0,
  ready_to_sell_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_vehicle_valuations_lead_id ON vehicle_valuations(lead_id);

CREATE TABLE valuation_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  valuation_id INTEGER NOT NULL REFERENCES vehicle_valuations(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_valuation_photos_valuation_id ON valuation_photos(valuation_id);

CREATE TABLE report_vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES find_car_reports(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  year INTEGER,
  make TEXT,
  model TEXT,
  trim TEXT,
  rationale TEXT,
  price INTEGER,
  mileage INTEGER,
  dealer_name TEXT,
  dealer_city TEXT,
  dealer_state TEXT,
  vdp_url TEXT,
  source TEXT,
  verified TEXT,
  engine TEXT,
  transmission TEXT,
  drivetrain TEXT,
  city_mpg INTEGER,
  highway_mpg INTEGER,
  exterior_color TEXT,
  exterior_color_options TEXT,
  safety_rating TEXT,
  cargo_space TEXT,
  seating_capacity INTEGER,
  warranty TEXT,
  notable_features TEXT,
  photo_url TEXT,
  photo_urls TEXT,
  search_log TEXT,
  interested INTEGER NOT NULL DEFAULT 0,
  interested_at TEXT,
  ready INTEGER NOT NULL DEFAULT 0,
  ready_at TEXT,
  white_glove_requested INTEGER NOT NULL DEFAULT 0,
  white_glove_requested_at TEXT,
  white_glove_fee INTEGER,
  photos_missing INTEGER NOT NULL DEFAULT 0
);

-- Tracks every Auto.dev API call (Find My Car listings + finalist photos) so
-- usage can be checked against the 1,000-call/month free tier.
CREATE TABLE autodev_api_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  params TEXT,
  status_code INTEGER,
  result_count INTEGER,
  lead_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_autodev_api_log_created_at ON autodev_api_log(created_at);
