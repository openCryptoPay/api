import type { MapPlaceInput, StoredMapPlace } from '@/lib/map/place';

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
  UNIQUE (origin, external_id)
)`;

/**
 * Store for map pins. The SQLite driver is `sqlite.ts`. Tests use the memory store.
 */
export interface MapPlaceStore {
  insertIfNew(input: MapPlaceInput): { created: boolean; place: StoredMapPlace };
  upsert(input: MapPlaceInput): { created: boolean; place: StoredMapPlace };
  deleteByKey(origin: string, externalId: string): boolean;
  list(limit: number): StoredMapPlace[];
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
      return { created: false, place: { ...existing } };
    }
    const place: StoredMapPlace = {
      ...input,
      techProvider: input.techProvider ?? DEFAULT_TECH_PROVIDER,
      id: crypto.randomUUID(),
      createdAt: this.#now().toISOString(),
    };
    this.#rows.push(place);
    return { created: true, place: { ...place } };
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
    if (input.techProvider !== undefined) {
      existing.techProvider = input.techProvider;
    }
    return { created: false, place: { ...existing } };
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
   * @returns A copy of the stored pins.
   */
  list(limit: number): StoredMapPlace[] {
    return [...this.#rows]
      .sort((a, b) => {
        const byTime = b.createdAt.localeCompare(a.createdAt);
        if (byTime !== 0) {
          return byTime;
        }
        return b.id.localeCompare(a.id);
      })
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  /** Nothing to close. */
  close(): void {
    this.#rows.length = 0;
  }
}
