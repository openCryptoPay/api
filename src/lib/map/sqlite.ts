import { Database } from 'bun:sqlite';
import type { MapPlaceInput, StoredMapPlace } from '@/lib/map/place';
import { MAP_PLACE_SCHEMA_SQL, type MapPlaceStore } from '@/lib/map/store';

const MAP_PLACE_COLUMNS =
  'id, origin, external_id, name, lat, lon, category, payment_methods, created_at, tech_provider';

type MapPlaceRow = {
  id: string;
  origin: string;
  external_id: string;
  name: string;
  lat: number;
  lon: number;
  category: string;
  payment_methods: string | null;
  created_at: string;
  tech_provider: string;
};

function mapRow(row: MapPlaceRow): StoredMapPlace {
  return {
    id: row.id,
    origin: row.origin,
    externalId: row.external_id,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    category: row.category,
    paymentMethods: row.payment_methods,
    createdAt: row.created_at,
    techProvider: row.tech_provider,
  };
}

/**
 * SQLite {@link MapPlaceStore}. Opened by the process entrypoint.
 * Unit tests use {@link MemoryMapPlaceStore}; this driver is exercised by
 * the HTTP end-to-end run.
 */
export class SqliteMapPlaceStore implements MapPlaceStore {
  readonly #db: Database;

  /**
   * @param filename - SQLite file, or `:memory:`.
   */
  constructor(filename: string) {
    this.#db = new Database(filename);
    this.#db.exec(MAP_PLACE_SCHEMA_SQL);
    const columns = this.#db.query('PRAGMA table_info(map_place)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'tech_provider')) {
      this.#db.exec(
        "ALTER TABLE map_place ADD COLUMN tech_provider TEXT NOT NULL DEFAULT 'DFX.swiss'",
      );
    }
  }

  /**
   * Insert when the pair is new. An existing pair is returned unchanged.
   *
   * @param input - Validated pin.
   * @returns Whether this call inserted the row.
   */
  insertIfNew(input: MapPlaceInput): { created: boolean; place: StoredMapPlace } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const techProvider = input.techProvider ?? 'DFX.swiss';
    const result = this.#db
      .query(
        `INSERT INTO map_place (
           id, origin, external_id, name, lat, lon, category, payment_methods, created_at, tech_provider
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (origin, external_id) DO NOTHING`,
      )
      .run(
        id,
        input.origin,
        input.externalId,
        input.name,
        input.lat,
        input.lon,
        input.category,
        input.paymentMethods,
        createdAt,
        techProvider,
      );
    if (result.changes === 1) {
      return { created: true, place: { ...input, techProvider, id, createdAt } };
    }
    const existing = this.#db
      .query(
        `SELECT ${MAP_PLACE_COLUMNS}
         FROM map_place WHERE origin = ? AND external_id = ?`,
      )
      .get(input.origin, input.externalId) as MapPlaceRow | null;
    if (existing === null) {
      throw new Error('map place insert conflict missing row');
    }
    return { created: false, place: mapRow(existing) };
  }

  /**
   * Insert when the pair is new, otherwise update the stored pin.
   *
   * @param input - Validated pin.
   * @returns Whether this call inserted the row.
   */
  upsert(input: MapPlaceInput): { created: boolean; place: StoredMapPlace } {
    const existing = this.#db
      .query(
        `SELECT ${MAP_PLACE_COLUMNS}
         FROM map_place WHERE origin = ? AND external_id = ?`,
      )
      .get(input.origin, input.externalId) as MapPlaceRow | null;
    if (existing === null) {
      return this.insertIfNew(input);
    }
    const techProvider =
      input.techProvider !== undefined ? input.techProvider : existing.tech_provider;
    this.#db
      .query(
        `UPDATE map_place
         SET name = ?, lat = ?, lon = ?, category = ?, payment_methods = ?, tech_provider = ?
         WHERE origin = ? AND external_id = ?`,
      )
      .run(
        input.name,
        input.lat,
        input.lon,
        input.category,
        input.paymentMethods,
        techProvider,
        input.origin,
        input.externalId,
      );
    return {
      created: false,
      place: {
        ...mapRow(existing),
        name: input.name,
        lat: input.lat,
        lon: input.lon,
        category: input.category,
        paymentMethods: input.paymentMethods,
        techProvider,
      },
    };
  }

  /**
   * Remove the pin for this origin and external id.
   *
   * @param origin - Pin origin.
   * @param externalId - Caller id.
   * @returns Whether a row was removed.
   */
  deleteByKey(origin: string, externalId: string): boolean {
    const result = this.#db
      .query('DELETE FROM map_place WHERE origin = ? AND external_id = ?')
      .run(origin, externalId);
    return result.changes > 0;
  }

  /**
   * Newest pins first.
   *
   * @param limit - Maximum rows.
   * @returns Stored pins.
   */
  list(limit: number): StoredMapPlace[] {
    const rows = this.#db
      .query(
        `SELECT ${MAP_PLACE_COLUMNS}
         FROM map_place
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit) as MapPlaceRow[];
    return rows.map((row) => mapRow(row));
  }

  /** Close the database. */
  close(): void {
    this.#db.close();
  }
}
