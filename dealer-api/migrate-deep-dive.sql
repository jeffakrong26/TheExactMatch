ALTER TABLE report_vehicles ADD COLUMN photo_urls TEXT;
ALTER TABLE report_vehicles ADD COLUMN ready INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_vehicles ADD COLUMN ready_at TEXT;
