-- "Currently Sourcing Buyers For" no longer gates publishing on a seller
-- opt-in checkbox — admin decides what's published, same as any other
-- admin-curated content. This column is fully unused now.
ALTER TABLE sell_my_car_leads DROP COLUMN feature_consent;
