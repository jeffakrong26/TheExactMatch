-- Follow-up to migrate-merge-dealers-partners.sql: columns the partners
-- table had that dealers didn't, missed on the first pass.
ALTER TABLE dealers ADD COLUMN phone TEXT;
ALTER TABLE dealers ADD COLUMN zip TEXT;
ALTER TABLE dealers ADD COLUMN city TEXT;
ALTER TABLE dealers ADD COLUMN state TEXT;
-- dealers.role already means permission level ('dealer' | 'admin') — the
-- partner application's "role" question (salesperson/sales_manager/
-- internet_bdc/gm, their job title at the dealership) is a different concept
-- and needs its own column, not a collision with the existing one.
ALTER TABLE dealers ADD COLUMN contact_role TEXT;
