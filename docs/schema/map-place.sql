-- Map pins keyed by origin and external id.
-- `name` is not unique here. A write that stores a name refuses another row's exact name. Rows that already share a name must still open.
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
  nostr_pubkey TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  google_maps_url TEXT,
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
-- One shop per NOSTR key (R7). Several rows stored before step 1a without a key are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS map_place_nostr_pubkey ON map_place (nostr_pubkey);
-- Every key a pair ever stored, kept after the place is deleted (R7). An admin
-- move by internal id points the place's own key at its new pair.
CREATE TABLE IF NOT EXISTS map_pubkey_reservation (
  nostr_pubkey TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Highest accepted request revision per pair, kept after the place is deleted (R8).
CREATE TABLE IF NOT EXISTS map_place_revision (
  origin TEXT NOT NULL,
  external_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (origin, external_id)
);
-- Each distinct shop photo once, by the SHA-256 of its stripped bytes.
CREATE TABLE IF NOT EXISTS map_photo (
  sha256 TEXT PRIMARY KEY,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 4096),
  data BLOB NOT NULL
);
-- A shop's photos in display order. A file a shop still uses cannot be deleted.
CREATE TABLE IF NOT EXISTS map_place_photo (
  place_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  sha256 TEXT NOT NULL,
  caption TEXT,
  PRIMARY KEY (place_id, position),
  FOREIGN KEY (place_id) REFERENCES map_place(id) ON DELETE CASCADE,
  FOREIGN KEY (sha256) REFERENCES map_photo(sha256)
);
