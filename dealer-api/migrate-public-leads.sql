-- Sell My Car: add every field the live 4-step form actually collects
ALTER TABLE sell_my_car_leads ADD COLUMN zip TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN trim TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN exterior_color TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN remaining_balance TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN payoff_amount TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN accidents TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN accidents_count TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN accidents_damage TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN mechanical_issues TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN mechanical_desc TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN warning_lights TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN windshield TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN tires TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN modifications TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN modifications_desc TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN keys TEXT;
ALTER TABLE sell_my_car_leads ADD COLUMN timeline TEXT;

-- Find My Car: brand-new table
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

-- Contact form: brand-new table
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
