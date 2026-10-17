import { matchesUnstatedPayment } from '@/lib/map/filter-catalog';
import {
  placeActivity,
  type MapPlaceInput,
  type MapPlaceQueryFilter,
  type MapPlaceSupport,
  type StoredMapPlace,
} from '@/lib/map/place';

const DEFAULT_TECH_PROVIDER = 'DFX.swiss';

/** SQLite schema for map pins. */
export const MAP_PLACE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS map_place (
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
CREATE INDEX IF NOT EXISTS map_place_activity_until ON map_place(activity_until)`;

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

function compareNewest(a: StoredMapPlace, b: StoredMapPlace): number {
  const byTime = b.createdAt.localeCompare(a.createdAt);
  if (byTime !== 0) {
    return byTime;
  }
  return b.id.localeCompare(a.id);
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

/**
 * List why the public map hides a stored pin. This defines the completeness rule for
 * `MemoryMapPlaceStore` and supplies `complete` and `problems` on `GET /admin/places`.
 * `SqliteMapPlaceStore` applies the same rule in SQL via `COMPLETE_PLACE_SQL` for its public list.
 * Empty when the pin is complete.
 * A row is complete when name, description, street, house number, postal code,
 * city, and country are non-empty, shop type is SPAR or Others, and
 * lastTransactionAt is null or a parseable instant.
 *
 * @param place - Stored pin, including an incomplete row.
 * @returns The problems, in check order. No I/O.
 */
export function placeProblems(place: StoredMapPlace): string[] {
  const problems: string[] = [];
  if (place.name === '') {
    problems.push('name is empty');
  }
  if (place.description === '') {
    problems.push('description is empty');
  }
  if (place.street === '') {
    problems.push('street is empty');
  }
  if (place.houseNumber === '') {
    problems.push('houseNumber is empty');
  }
  if (place.postalCode === '') {
    problems.push('postalCode is empty');
  }
  if (place.city === '') {
    problems.push('city is empty');
  }
  if (place.country === '') {
    problems.push('country is empty');
  }
  if (place.shopType !== 'SPAR' && place.shopType !== 'Others') {
    problems.push('shopType must be SPAR or Others');
  }
  const lastTransactionAt = place.lastTransactionAt;
  const lastInstantOk =
    lastTransactionAt === null || Number.isFinite(Date.parse(lastTransactionAt));
  if (!lastInstantOk) {
    problems.push('lastTransactionAt is not a valid instant');
  }
  return problems;
}

function isCompletePlace(row: StoredMapPlace): boolean {
  return placeProblems(row).length === 0;
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
  if (filter.shopType !== undefined && row.shopType !== filter.shopType) {
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
    description: input.description,
    lat: input.lat,
    lon: input.lon,
    category: input.category,
    paymentMethods: input.paymentMethods,
    techProvider: input.techProvider ?? DEFAULT_TECH_PROVIDER,
    shopType: input.shopType,
    street: input.street,
    houseNumber: input.houseNumber,
    postalCode: input.postalCode,
    city: input.city,
    country: input.country,
    supports: storedSupports(input.supports),
    lastTransactionAt: null,
    activity: 'none',
    id,
    createdAt,
  };
}

function utcDayFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function windowStartDay(nowMs: number): string {
  const end = utcDayFromMs(nowMs);
  const year = Number(end.slice(0, 4));
  const month = Number(end.slice(5, 7));
  const date = Number(end.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, date - 6)).toISOString().slice(0, 10);
}

function paymentDayInWindow(day: string, nowMs: number): boolean {
  return day >= windowStartDay(nowMs) && day <= utcDayFromMs(nowMs);
}

function storedPaymentDays(days: Set<string> | undefined): string[] {
  if (days === undefined) {
    return [];
  }
  return [...days];
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
    nowMs: number,
  ): StoredMapPlace | undefined;
  refreshActivity(nowMs: number): void;
  deleteByKey(origin: string, externalId: string): boolean;
  list(limit: number, filter?: MapPlaceListFilter): StoredMapPlace[];
  listAll(): StoredMapPlace[];
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
  readonly #paymentDays = new Map<string, Set<string>>();
  readonly #activityUntil = new Map<string, string>();
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
   * Insert when the pair is new, otherwise replace every field of the stored pin.
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
    existing.description = input.description;
    existing.lat = input.lat;
    existing.lon = input.lon;
    existing.category = input.category;
    existing.paymentMethods = input.paymentMethods;
    existing.techProvider = input.techProvider ?? DEFAULT_TECH_PROVIDER;
    existing.shopType = input.shopType;
    existing.street = input.street;
    existing.houseNumber = input.houseNumber;
    existing.postalCode = input.postalCode;
    existing.city = input.city;
    existing.country = input.country;
    existing.supports = storedSupports(input.supports);
    return { created: false, place: copyStoredPlace(existing) };
  }

  /**
   * Store a newer transaction instant for an existing pin and refresh its activity.
   *
   * @param origin - Pin origin.
   * @param externalId - Caller id.
   * @param occurredAt - Instant to store. An unparseable argument is ignored.
   * @param nowMs - Maintenance clock in milliseconds.
   * @returns A copy of the row, or undefined when the pair is missing. A written instant is
   * canonical ISO.
   */
  recordTransaction(
    origin: string,
    externalId: string,
    occurredAt: string,
    nowMs: number,
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
    if (!Number.isFinite(storedMs) || storedMs < newMs) {
      existing.lastTransactionAt = canonical;
    }
    const start = windowStartDay(nowMs);
    let days = this.#paymentDays.get(existing.id);
    if (days !== undefined) {
      for (const day of [...days]) {
        if (day < start) {
          days.delete(day);
        }
      }
    }
    const day = utcDayFromMs(newMs);
    if (paymentDayInWindow(day, nowMs)) {
      if (days === undefined) {
        days = new Set<string>();
        this.#paymentDays.set(existing.id, days);
      }
      days.add(day);
    }
    const classified = placeActivity(existing.lastTransactionAt, storedPaymentDays(days), nowMs);
    existing.activity = classified.activity;
    if (classified.until === null) {
      this.#activityUntil.delete(existing.id);
    } else {
      this.#activityUntil.set(existing.id, classified.until);
    }
    return copyStoredPlace(existing);
  }

  /**
   * Recompute activity for rows whose stored `activity_until` is due.
   *
   * @param nowMs - Maintenance clock in milliseconds.
   */
  refreshActivity(nowMs: number): void {
    const nowIso = new Date(nowMs).toISOString();
    const start = windowStartDay(nowMs);
    for (const row of this.#rows) {
      const until = this.#activityUntil.get(row.id);
      if (until === undefined) {
        continue;
      }
      if (until > nowIso) {
        continue;
      }
      const days = this.#paymentDays.get(row.id);
      if (days !== undefined) {
        for (const day of [...days]) {
          if (day < start) {
            days.delete(day);
          }
        }
      }
      const classified = placeActivity(row.lastTransactionAt, storedPaymentDays(days), nowMs);
      row.activity = classified.activity;
      if (classified.until === null) {
        this.#activityUntil.delete(row.id);
      } else {
        this.#activityUntil.set(row.id, classified.until);
      }
    }
  }

  /**
   * Remove the pin for this origin and external id.
   *
   * @param origin - Pin origin.
   * @param externalId - Caller id.
   * @returns Whether a row was removed.
   */
  deleteByKey(origin: string, externalId: string): boolean {
    const existing = this.#rows.find(
      (row) => row.origin === origin && row.externalId === externalId,
    );
    if (existing === undefined) {
      return false;
    }
    this.#paymentDays.delete(existing.id);
    this.#activityUntil.delete(existing.id);
    this.#rows.splice(this.#rows.indexOf(existing), 1);
    return true;
  }

  /**
   * Newest complete pins first, then id descending.
   *
   * @param limit - Maximum rows.
   * @param filter - Optional AND predicates, applied before sort and limit.
   * @returns A copy of the stored pins.
   */
  list(limit: number, filter?: MapPlaceListFilter): StoredMapPlace[] {
    const rows = this.#rows.filter((row) => isCompletePlace(row) && matchesFilter(row, filter));
    return [...rows]
      .sort(compareNewest)
      .slice(0, limit)
      .map((row) => copyStoredPlace(row));
  }

  /**
   * Every stored pin, including incomplete ones. Newest first, then id descending.
   *
   * @returns A copy of each row. No filter and no limit.
   */
  listAll(): StoredMapPlace[] {
    return [...this.#rows].sort(compareNewest).map((row) => copyStoredPlace(row));
  }

  /**
   * Distinct stored filter values, sorted.
   *
   * @param blockchain - When set, only assets stored on that network.
   * @returns Countries of complete rows, plus blockchains and assets from every row.
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
      if (isCompletePlace(row)) {
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
    this.#paymentDays.clear();
    this.#activityUntil.clear();
  }
}
