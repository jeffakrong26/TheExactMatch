CREATE TABLE find_car_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_code TEXT NOT NULL UNIQUE,
  find_lead_id INTEGER NOT NULL REFERENCES find_car_leads(id),
  status TEXT NOT NULL DEFAULT 'pending_approval',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT
);

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
  interested INTEGER NOT NULL DEFAULT 0,
  interested_at TEXT
);
