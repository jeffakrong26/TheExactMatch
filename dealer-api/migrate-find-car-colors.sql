-- Find My Car: optional exterior/interior color preference (basic families
-- from the form's dropdowns). dealer-api also adds these on first use, so
-- running this by hand is optional.
ALTER TABLE find_car_leads ADD COLUMN exterior_color_pref TEXT;
ALTER TABLE find_car_leads ADD COLUMN interior_color_pref TEXT;
