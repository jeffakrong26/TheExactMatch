-- Broader exotic/supercar/hypercar/luxury/sports-brand reference table.
-- Doubles as (a) the hard ingestion filter for exotic-corner auction
-- sources — a scraped listing that matches neither this table nor
-- exotic_watchlist is discarded outright, not stored and hidden later — and
-- (b) the autocomplete seed for the watchlist admin form. See
-- matchVehicleReference() in src/index.js.
--
-- Model values are usually the bare model name (matching is brand+model,
-- fuzzy on the model side, tolerant of new/unlisted trims and generations
-- under an already-listed model). Where only a specific trim of an
-- otherwise-mainstream model actually qualifies (e.g. a base Dodge
-- Challenger or base Alfa Giulia is not exotic-corner material), the model
-- value is the full qualifying phrase instead (e.g. "Challenger Hellcat")
-- so ordinary trims of that model don't pass the filter.
CREATE TABLE IF NOT EXISTS vehicle_reference (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  category TEXT  -- exotic | supercar | hypercar | luxury | sports
);

CREATE INDEX idx_vehicle_reference_brand ON vehicle_reference(brand);

INSERT INTO vehicle_reference (brand, model, category) VALUES
  ('Ferrari', 'Roma', 'exotic'),
  ('Ferrari', 'Portofino', 'exotic'),
  ('Ferrari', '296', 'exotic'),
  ('Ferrari', 'SF90', 'exotic'),
  ('Ferrari', '812', 'exotic'),
  ('Ferrari', 'F8', 'exotic'),
  ('Ferrari', '488', 'exotic'),
  ('Ferrari', '458', 'exotic'),
  ('Ferrari', '599', 'exotic'),
  ('Ferrari', '612', 'exotic'),
  ('Ferrari', 'California', 'exotic'),
  ('Ferrari', 'F12', 'exotic'),
  ('Ferrari', 'LaFerrari', 'hypercar'),
  ('Ferrari', 'Purosangue', 'exotic'),

  ('Lamborghini', 'Huracan', 'exotic'),
  ('Lamborghini', 'Aventador', 'exotic'),
  ('Lamborghini', 'Urus', 'exotic'),
  ('Lamborghini', 'Gallardo', 'exotic'),
  ('Lamborghini', 'Murcielago', 'exotic'),
  ('Lamborghini', 'Revuelto', 'exotic'),
  ('Lamborghini', 'Diablo', 'exotic'),
  ('Lamborghini', 'Countach', 'exotic'),

  ('Porsche', '911', 'sports'),
  ('Porsche', '718', 'sports'),
  ('Porsche', 'Cayman', 'sports'),
  ('Porsche', 'Boxster', 'sports'),
  ('Porsche', 'Taycan', 'sports'),
  ('Porsche', 'Panamera', 'sports'),
  ('Porsche', 'Cayenne', 'sports'),
  ('Porsche', 'Carrera GT', 'hypercar'),
  ('Porsche', '918', 'hypercar'),

  ('McLaren', '570S', 'exotic'),
  ('McLaren', '570GT', 'exotic'),
  ('McLaren', '600LT', 'exotic'),
  ('McLaren', '720S', 'exotic'),
  ('McLaren', '765LT', 'exotic'),
  ('McLaren', 'GT', 'exotic'),
  ('McLaren', 'Artura', 'exotic'),
  ('McLaren', 'Senna', 'hypercar'),
  ('McLaren', 'P1', 'hypercar'),
  ('McLaren', '675LT', 'exotic'),

  ('Aston Martin', 'Vantage', 'exotic'),
  ('Aston Martin', 'DB11', 'exotic'),
  ('Aston Martin', 'DB12', 'exotic'),
  ('Aston Martin', 'DBS', 'exotic'),
  ('Aston Martin', 'DBX', 'exotic'),
  ('Aston Martin', 'Valhalla', 'hypercar'),
  ('Aston Martin', 'Valkyrie', 'hypercar'),
  ('Aston Martin', 'Vanquish', 'exotic'),
  ('Aston Martin', 'Rapide', 'exotic'),
  ('Aston Martin', 'V12 Zagato', 'exotic'),

  ('Bentley', 'Continental GT', 'luxury'),
  ('Bentley', 'Flying Spur', 'luxury'),
  ('Bentley', 'Bentayga', 'luxury'),
  ('Bentley', 'Mulsanne', 'luxury'),

  ('Rolls-Royce', 'Ghost', 'luxury'),
  ('Rolls-Royce', 'Phantom', 'luxury'),
  ('Rolls-Royce', 'Cullinan', 'luxury'),
  ('Rolls-Royce', 'Wraith', 'luxury'),
  ('Rolls-Royce', 'Dawn', 'luxury'),
  ('Rolls-Royce', 'Spectre', 'luxury'),

  ('Bugatti', 'Chiron', 'hypercar'),
  ('Bugatti', 'Veyron', 'hypercar'),
  ('Bugatti', 'Divo', 'hypercar'),

  ('Koenigsegg', 'Jesko', 'hypercar'),
  ('Koenigsegg', 'Agera', 'hypercar'),
  ('Koenigsegg', 'Regera', 'hypercar'),
  ('Koenigsegg', 'Gemera', 'hypercar'),
  ('Koenigsegg', 'CC850', 'hypercar'),

  ('Pagani', 'Huayra', 'hypercar'),
  ('Pagani', 'Zonda', 'hypercar'),
  ('Pagani', 'Utopia', 'hypercar'),

  ('Maserati', 'GranTurismo', 'exotic'),
  ('Maserati', 'MC20', 'exotic'),
  ('Maserati', 'Quattroporte', 'exotic'),
  ('Maserati', 'Levante', 'exotic'),
  ('Maserati', 'Ghibli', 'exotic'),

  ('Lotus', 'Emira', 'sports'),
  ('Lotus', 'Evora', 'sports'),
  ('Lotus', 'Exige', 'sports'),
  ('Lotus', 'Elise', 'sports'),
  ('Lotus', 'Evija', 'hypercar'),

  ('Nissan', 'GT-R', 'sports'),

  ('Acura', 'NSX', 'sports'),
  ('Honda', 'NSX', 'sports'),

  ('Audi', 'R8', 'sports'),
  ('Audi', 'RS6', 'sports'),
  ('Audi', 'RS7', 'sports'),
  ('Audi', 'RS e-tron GT', 'sports'),

  ('BMW', 'M3', 'sports'),
  ('BMW', 'M4', 'sports'),
  ('BMW', 'M5', 'sports'),
  ('BMW', 'M8', 'sports'),
  ('BMW', 'i8', 'sports'),
  ('BMW', 'Z4 M', 'sports'),
  ('BMW', '8 Series', 'sports'),

  ('Mercedes-Benz', 'AMG GT', 'sports'),
  ('Mercedes-Benz', 'SL', 'sports'),
  ('Mercedes-Benz', 'SLS', 'exotic'),
  ('Mercedes-Benz', 'C63', 'sports'),
  ('Mercedes-Benz', 'E63', 'sports'),
  ('Mercedes-Benz', 'G63', 'sports'),
  ('Mercedes-Benz', 'AMG One', 'hypercar'),
  ('Mercedes-AMG', 'GT', 'sports'),
  ('Mercedes-AMG', 'SL', 'sports'),
  ('Mercedes-AMG', 'C63', 'sports'),
  ('Mercedes-AMG', 'E63', 'sports'),
  ('Mercedes-AMG', 'G63', 'sports'),
  ('Mercedes-AMG', 'One', 'hypercar'),

  ('Chevrolet', 'Corvette', 'sports'),

  ('Dodge', 'Viper', 'sports'),
  ('Dodge', 'Challenger Hellcat', 'sports'),
  ('Dodge', 'Challenger Demon', 'sports'),

  ('Jaguar', 'F-Type', 'sports'),
  ('Jaguar', 'XKR', 'sports'),

  ('Alfa Romeo', '4C', 'sports'),
  ('Alfa Romeo', 'Giulia Quadrifoglio', 'sports'),
  ('Alfa Romeo', 'Stelvio Quadrifoglio', 'sports'),

  ('Land Rover', 'Range Rover SV', 'luxury'),
  ('Land Rover', 'Range Rover Sport SV', 'luxury'),

  ('Rimac', 'Nevera', 'hypercar'),

  ('Hennessey', 'Venom F5', 'hypercar'),

  ('De Tomaso', 'Pantera', 'exotic'),
  ('De Tomaso', 'P72', 'exotic'),

  ('TVR', 'Griffith', 'sports'),

  ('Ford', 'GT', 'exotic');
