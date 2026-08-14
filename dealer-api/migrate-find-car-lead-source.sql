-- Tags each find_car_leads row with where it came from, so admin-created
-- reports (the manual entry point at /api/admin/find-leads/manual) can be
-- told apart from organic customer-form submissions in reporting.
ALTER TABLE find_car_leads ADD COLUMN source TEXT NOT NULL DEFAULT 'customer_form';
