-- Newsletter/dealer submissions: bring inventory_submissions up to the same
-- structured-data standard as Find My Car reports (listing URL, photos,
-- full specs) instead of a dealer-typed free-text paragraph.
-- Note: `trim` already existed on the live table (schema.sql's reference copy
-- was stale on this one column) — omitted here to avoid a duplicate-column error.
ALTER TABLE inventory_submissions ADD COLUMN listing_url TEXT;
ALTER TABLE inventory_submissions ADD COLUMN vin TEXT;
ALTER TABLE inventory_submissions ADD COLUMN exterior_color TEXT;
ALTER TABLE inventory_submissions ADD COLUMN engine TEXT;
ALTER TABLE inventory_submissions ADD COLUMN transmission TEXT;
ALTER TABLE inventory_submissions ADD COLUMN photo_url TEXT;
