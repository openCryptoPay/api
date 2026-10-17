-- Map pins keyed by origin and external id.
CREATE TABLE IF NOT EXISTS map_place (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  category TEXT NOT NULL,
  payment_methods TEXT,
  created_at TEXT NOT NULL,
  tech_provider TEXT NOT NULL DEFAULT 'DFX.swiss',
  country TEXT,
  street TEXT,
  house_number TEXT,
  postal_code TEXT,
  city TEXT,
  shop_type TEXT,
  last_transaction_at TEXT,
  activity TEXT NOT NULL DEFAULT 'none',
  activity_until TEXT,
  UNIQUE (origin, external_id)
);
CREATE TABLE IF NOT EXISTS map_place_support (
  place_id TEXT NOT NULL,
  blockchain TEXT NOT NULL,
  asset TEXT NOT NULL,
  PRIMARY KEY (place_id, blockchain, asset),
  FOREIGN KEY (place_id) REFERENCES map_place(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS map_place_country ON map_place(country);
CREATE INDEX IF NOT EXISTS map_place_support_lookup
  ON map_place_support(blockchain, asset, place_id);
CREATE TABLE IF NOT EXISTS map_place_payment_day (
  place_id TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (place_id, day),
  FOREIGN KEY (place_id) REFERENCES map_place(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS map_place_activity_until ON map_place(activity_until);
