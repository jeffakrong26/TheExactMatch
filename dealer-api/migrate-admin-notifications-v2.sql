-- Replaces the per-section "last viewed tab" badge model with per-item
-- tracking: a badge only clears for the specific submission Jeff actually
-- reviewed/approved/expanded, never just from opening a tab.
DROP TABLE IF EXISTS admin_section_views;

CREATE TABLE admin_seen_items (
  section TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (section, item_id)
);

-- Backfill: mark everything that already existed before this migration as
-- seen, so the badges start clean and only count genuinely new activity
-- going forward instead of surfacing months of historical rows.
INSERT INTO admin_seen_items (section, item_id)
  SELECT 'newsletter', id FROM inventory_submissions;
INSERT INTO admin_seen_items (section, item_id)
  SELECT 'find_car', id FROM find_car_reports;
INSERT INTO admin_seen_items (section, item_id)
  SELECT 'sell_car', id FROM sell_my_car_leads;
INSERT INTO admin_seen_items (section, item_id)
  SELECT 'messages', id FROM contact_messages;
INSERT INTO admin_seen_items (section, item_id)
  SELECT 'dealers', id FROM dealers WHERE role != 'admin';
