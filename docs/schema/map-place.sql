-- Map pins keyed by origin and external id.
CREATE TABLE IF NOT EXISTS map_place (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  category TEXT NOT NULL,
  payment_methods TEXT,
  created_at TEXT NOT NULL,
  tech_provider TEXT NOT NULL DEFAULT 'DFX.swiss',
  country TEXT,
  shop_name TEXT,
  last_transaction_at TEXT,
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
CREATE INDEX IF NOT EXISTS map_place_shop_name ON map_place(shop_name);
CREATE INDEX IF NOT EXISTS map_place_support_lookup
  ON map_place_support(blockchain, asset, place_id);
