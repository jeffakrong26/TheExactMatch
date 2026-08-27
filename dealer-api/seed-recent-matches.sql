-- Initial 3 Recent Matches. Andy's photo already exists on disk
-- (aston-martin-vantage.jpg) and is uploaded separately via `wrangler r2
-- object put` + an UPDATE of its photo_key, right after this file runs.
-- Samantha's and Casey's have no photo file to upload yet — they publish
-- with the "Photo coming soon" placeholder until real photos are added
-- through the admin panel.
INSERT INTO recent_matches (slug, first_name, vehicle, card_title, savings_amount, tags, featured, status, published_at) VALUES
('samantha-cx5', 'Samantha', '2026 Mazda CX-5', 'Samantha''s CX5', 6000,
  '["0% APR financing secured","At-home test drive arranged","Above-market trade-in allowance"]',
  1, 'published', datetime('now')),
('casey-huracan', 'Casey', '2019 Lamborghini Huracán', 'Casey''s Huracan', 8000,
  '["CPO warranty secured","Transport arranged (Miami, FL → Austin, TX)","Full detail package (PPF, ceramic coating, dent removal)"]',
  1, 'published', datetime('now')),
('andy-vantage', 'Andy', '2019 Aston Martin Vantage S', 'Andy''s Vantage', 7000,
  '["CPO warranty secured"]',
  1, 'published', datetime('now'));
