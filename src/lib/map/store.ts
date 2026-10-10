import { matchesUnstatedPayment } from '@/lib/map/filter-catalog';
import type {
  MapPlaceInput,
  MapPlaceQueryFilter,
  MapPlaceSupport,
  StoredMapPlace,
} from '@/lib/map/place';

const DEFAULT_TECH_PROVIDER = 'DFX.swiss';

/** SQLite schema for map pins. */
export const MAP_PLACE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS map_place (
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
  ON map_place_support(blockchain, asset, place_id)`;

/** Optional AND predicates for `list`, applied before sort and limit. */
export type MapPlaceListFilter = MapPlaceQueryFilter & {
  origin?: string;
};

function compareSupport(a: MapPlaceSupport, b: MapPlaceSupport): number {
  if (a.blockchain < b.blockchain) {
    return -1;
  }
  if (a.blockchain > b.blockchain) {
    return 1;
  }
  if (a.asset < b.asset) {
    return -1;
  }
  if (a.asset > b.asset) {
    return 1;
  }
  return 0;
}

function storedSupports(items: MapPlaceSupport[]): MapPlaceSupport[] {
  const sorted = [...items]
    .map((item) => ({ blockchain: item.blockchain, asset: item.asset }))
    .sort(compareSupport);
  const unique: MapPlaceSupport[] = [];
  for (const item of sorted) {
    const prev = unique[unique.length - 1];
    if (prev !== undefined && prev.blockchain === item.blockchain && prev.asset === item.asset) {
      continue;
    }
    unique.push(item);
  }
  return unique;
}

function copyStoredPlace(place: StoredMapPlace): StoredMapPlace {
  return {
    ...place,
    supports: place.supports.map((item) => ({
      blockchain: item.blockchain,
      asset: item.asset,
    })),
  };
}

function matchesFilter(row: StoredMapPlace, filter?: MapPlaceListFilter): boolean {
  if (filter === undefined) {
    return true;
  }
  if (filter.origin !== undefined && row.origin !== filter.origin) {
    return false;
  }
  if (filter.country !== undefined && row.country !== filter.country) {
    return false;
  }
  if (filter.shopName === 'SPAR' && row.shopName !== 'SPAR') {
    return false;
  }
  if (filter.shopName === 'others' && row.shopName === 'SPAR') {
    return false;
  }
  if (filter.blockchain !== undefined || filter.asset !== undefined) {
    const match =
      row.supports.length > 0
        ? row.supports.some(
            (item) =>
              (filter.blockchain === undefined || item.blockchain === filter.blockchain) &&
              (filter.asset === undefined || item.asset === filter.asset),
          )
        : matchesUnstatedPayment(row.origin, row.techProvider, filter.blockchain, filter.asset);
    if (!match) {
      return false;
    }
  }
  return true;
}

function toStoredPlace(input: MapPlaceInput, id: string, createdAt: string): StoredMapPlace {
  return {
    origin: input.origin,
    externalId: input.externalId,
    name: input.name,
    lat: input.lat,
    lon: input.lon,
    category: input.category,
    paymentMethods: input.paymentMethods,
    techProvider: input.techProvider ?? DEFAULT_TECH_PROVIDER,
    country: input.country ?? null,
    shopName: input.shopName ?? null,
    supports: storedSupports(input.supports ?? []),
    lastTransactionAt: null,
    id,
    createdAt,
  };
}

/**
 * Store for map pins. The SQLite driver is `sqlite.ts`. Tests use the memory store.
 */
export interface MapPlaceStore {
  insertIfNew(input: MapPlaceInput): { created: boolean; place: StoredMapPlace };
  upsert(input: MapPlaceInput): { created: boolean; place: StoredMapPlace };
  recordTransaction(
    origin: string,
    externalId: string,
    occurredAt: string,
  ): StoredMapPlace | undefined;
  deleteByKey(origin: string, externalId: string): boolean;
  list(limit: number, filter?: MapPlaceListFilter): StoredMapPlace[];
  filters(blockchain?: string | undefined): {
    countries: string[];
    blockchains: string[];
    assets: string[];
  };
  close(): void;
}

/**
 * Process-local map store. Same insert-once, upsert, and delete rules as SQLite.
 */
export class MemoryMapPlaceStore implements MapPlaceStore {
  readonly #rows: StoredMapPlace[] = [];
  readonly #now: () => Date;

  /**
   * @param now - Clock for `createdAt`. Defaults to `Date`.
   */
  constructor(now?: () => Date) {
    this.#now = now ?? (() => new Date());
  }

  /**
   * Insert when the pair is new. An existing pair is returned unchanged.
   *
   * @param input - Validated pin.
   * @returns Whether this call inserted the row.
   */
  insertIfNew(input: MapPlaceInput): { created: boolean; place: StoredMapPlace } {
    const existing = this.#rows.find(
      (row) => row.origin === input.origin && row.externalId === input.externalId,
    );
    if (existing !== undefined) {
      return { created: false, place: copyStoredPlace(existing) };
    }
    const place = toStoredPlace(input, crypto.randomUUID(), this.#now().toISOString());
    this.#rows.push(place);
    return { created: true, place: copyStoredPlace(place) };
  }

  /**
   * Insert when the pair is new, otherwise update the stored pin.
   *
   * @param input - Validated pin.
   * @returns Whether this call inserted the row.
   */
  upsert(input: MapPlaceInput): { created: boolean; place: StoredMapPlace } {
    const existing = this.#rows.find(
      (row) => row.origin === input.origin && row.externalId === input.externalId,
    );
    if (existing === undefined) {
      return this.insertIfNew(input);
    }
    existing.name = input.name;
    existing.lat = input.lat;
    existing.lon = input.lon;
    existing.category = input.category;
    existing.paymentMethods = input.paymentMethods;
    existing.country = input.country ?? null;
    existing.shopName = input.shopName ?? null;
    if (input.techProvider !== undefined) {
      existing.techProvider = input.techProvider;
    }
    if (input.supports !== undefined) {
      existing.supports = storedSupports(input.supports);
    }
    return { created: false, place: copyStoredPlace(existing) };
  }

  /**
   * Store a newer transaction instant for an existing pin.
   *
   * @param origin - Pin origin.
   * @param externalId - Caller id.
   * @param occurredAt - Instant to store. An unparseable argument is ignored.
   * @returns A copy of the row, or undefined when the pair is missing. A written instant is
   * canonical ISO.
   */
  recordTransaction(
    origin: string,
    externalId: string,
    occurredAt: string,
  ): StoredMapPlace | undefined {
    const existing = this.#rows.find(
      (row) => row.origin === origin && row.externalId === externalId,
    );
    if (existing === undefined) {
      return undefined;
    }
    const newMs = Date.parse(occurredAt);
    if (!Number.isFinite(newMs)) {
      return copyStoredPlace(existing);
    }
    const canonical = new Date(newMs).toISOString();
    const storedMs =
      existing.lastTransactionAt === null ? Number.NaN : Date.parse(existing.lastTransactionAt);
    if (Number.isFinite(storedMs) && storedMs >= newMs) {
      return copyStoredPlace(existing);
    }
    existing.lastTransactionAt = canonical;
    return copyStoredPlace(existing);
  }

  /**
   * Remove the pin for this origin and external id.
   *
   * @param origin - Pin origin.
   * @param externalId - Caller id.
   * @returns Whether a row was removed.
   */
  deleteByKey(origin: string, externalId: string): boolean {
    const index = this.#rows.findIndex(
      (row) => row.origin === origin && row.externalId === externalId,
    );
    if (index < 0) {
      return false;
    }
    this.#rows.splice(index, 1);
    return true;
  }

  /**
   * Newest pins first, then id descending.
   *
   * @param limit - Maximum rows.
   * @param filter - Optional AND predicates, applied before sort and limit.
   * @returns A copy of the stored pins.
   */
  list(limit: number, filter?: MapPlaceListFilter): StoredMapPlace[] {
    const rows = this.#rows.filter((row) => matchesFilter(row, filter));
    return [...rows]
      .sort((a, b) => {
        const byTime = b.createdAt.localeCompare(a.createdAt);
        if (byTime !== 0) {
          return byTime;
        }
        return b.id.localeCompare(a.id);
      })
      .slice(0, limit)
      .map((row) => copyStoredPlace(row));
  }

  /**
   * Distinct stored filter values, sorted.
   *
   * @param blockchain - When set, only assets stored on that network.
   * @returns Countries, blockchains, and assets. Shop names are not read.
   */
  filters(blockchain?: string | undefined): {
    countries: string[];
    blockchains: string[];
    assets: string[];
  } {
    const countrySet = new Set<string>();
    const blockchainSet = new Set<string>();
    const assetSet = new Set<string>();
    for (const row of this.#rows) {
      if (row.country !== null) {
        countrySet.add(row.country);
      }
      for (const item of row.supports) {
        blockchainSet.add(item.blockchain);
        if (blockchain === undefined || item.blockchain === blockchain) {
          assetSet.add(item.asset);
        }
      }
    }
    return {
      countries: [...countrySet].sort(),
      blockchains: [...blockchainSet].sort(),
      assets: [...assetSet].sort(),
    };
  }

  /** Nothing to close. */
  close(): void {
    this.#rows.length = 0;
  }
}
