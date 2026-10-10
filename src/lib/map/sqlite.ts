import { Database } from 'bun:sqlite';
import { unstatedPaymentSql } from '@/lib/map/filter-catalog';
import type { MapPlaceInput, MapPlaceSupport, StoredMapPlace } from '@/lib/map/place';
import { MAP_PLACE_SCHEMA_SQL, type MapPlaceListFilter, type MapPlaceStore } from '@/lib/map/store';

const MAP_PLACE_COLUMNS =
  'id, origin, external_id, name, lat, lon, category, payment_methods, created_at, tech_provider, country, shop_name, last_transaction_at';

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
  country: string | null;
  shop_name: string | null;
  last_transaction_at: string | null;
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

function mapRow(row: MapPlaceRow, supports: MapPlaceSupport[]): StoredMapPlace {
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
    country: row.country,
    shopName: row.shop_name,
    lastTransactionAt: row.last_transaction_at,
    supports: supports.map((item) => ({ blockchain: item.blockchain, asset: item.asset })),
  };
}

function loadSupportsByPlaceId(db: Database, ids: string[]): Map<string, MapPlaceSupport[]> {
  const supportsById = new Map<string, MapPlaceSupport[]>();
  for (const id of ids) {
    supportsById.set(id, []);
  }
  if (ids.length === 0) {
    return supportsById;
  }
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .query(
      `SELECT place_id, blockchain, asset
       FROM map_place_support
       WHERE place_id IN (${placeholders})
       ORDER BY blockchain, asset`,
    )
    .all(...ids) as Array<{ place_id: string; blockchain: string; asset: string }>;
  for (const row of rows) {
    const list = supportsById.get(row.place_id);
    if (list === undefined) {
      throw new Error('map place support for unknown id');
    }
    list.push({ blockchain: row.blockchain, asset: row.asset });
  }
  return supportsById;
}

function mapRows(db: Database, rows: MapPlaceRow[]): StoredMapPlace[] {
  const supportsById = loadSupportsByPlaceId(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const supports = supportsById.get(row.id);
    if (supports === undefined) {
      throw new Error('map place supports missing');
    }
    return mapRow(row, supports);
  });
}

function mapOne(db: Database, row: MapPlaceRow): StoredMapPlace {
  const mapped = mapRows(db, [row]);
  const place = mapped[0];
  if (place === undefined) {
    throw new Error('map place row missing after map');
  }
  return place;
}

const LI_POSTAL_CODES: ReadonlySet<string> = new Set([
  '9485',
  '9486',
  '9487',
  '9488',
  '9490',
  '9491',
  '9492',
  '9493',
  '9494',
  '9495',
  '9496',
  '9497',
  '9498',
]);

const GIFTS_COUNTRY_BY_EXACT_NAME: ReadonlyMap<string, string> = new Map([
  ['Happyland Court Barangay 105 Tondo, Manila', 'PH'],
  ['Rose st.Happyland Barangay 105 Tondo,Manila', 'PH'],
  ['Machakos Bitcoin Academy', 'KE'],
  ['bitcoinmakueni', 'KE'],
]);

function lastFourDigitWord(name: string): string | undefined {
  let found: string | undefined;
  for (const word of name.split(/\s+/)) {
    if (/^[0-9]{4}$/.test(word)) {
      found = word;
    }
  }
  return found;
}

function countryFromSparName(name: string): 'LI' | 'CH' | undefined {
  const code = lastFourDigitWord(name);
  if (code === undefined) {
    return undefined;
  }
  if (LI_POSTAL_CODES.has(code)) {
    return 'LI';
  }
  const numeric = Number(code);
  if (numeric >= 1000 && numeric <= 9999) {
    return 'CH';
  }
  return undefined;
}

function backfillMissingCountry(db: Database): void {
  const rows = db
    .query(
      `SELECT id, origin, name
       FROM map_place
       WHERE country IS NULL AND (origin = 'spar' OR origin = '21gifts')`,
    )
    .all() as Array<{ id: string; origin: string; name: string }>;
  const update = db.query('UPDATE map_place SET country = ? WHERE id = ? AND country IS NULL');
  for (const row of rows) {
    let country: string | undefined;
    if (row.origin === 'spar') {
      country = countryFromSparName(row.name);
    } else if (row.origin === '21gifts') {
      country = GIFTS_COUNTRY_BY_EXACT_NAME.get(row.name);
    } else {
      throw new Error('country backfill unexpected origin');
    }
    if (country !== undefined) {
      update.run(country, row.id);
    }
  }
}

function insertSupportRows(db: Database, placeId: string, supports: MapPlaceSupport[]): void {
  const insert = db.query(
    'INSERT INTO map_place_support (place_id, blockchain, asset) VALUES (?, ?, ?)',
  );
  for (const item of supports) {
    insert.run(placeId, item.blockchain, item.asset);
  }
}

function replaceSupportRows(db: Database, placeId: string, supports: MapPlaceSupport[]): void {
  db.query('DELETE FROM map_place_support WHERE place_id = ?').run(placeId);
  insertSupportRows(db, placeId, supports);
}

/**
 * SQLite {@link MapPlaceStore}. Opened by the process entrypoint.
 * Insert, list, and delete are exercised by the HTTP end-to-end run.
 * The SPAR shop-name backfill and the country backfill (null country only)
 * are exercised by e2e/sqlite-backfill.ts.
 */
export class SqliteMapPlaceStore implements MapPlaceStore {
  readonly #db: Database;

  /**
   * @param filename - SQLite file, or `:memory:`.
   */
  constructor(filename: string) {
    this.#db = new Database(filename);
    this.#db.exec('PRAGMA foreign_keys = ON');
    const statements = MAP_PLACE_SCHEMA_SQL.split(';')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    for (const [index, sql] of statements.entries()) {
      this.#db.exec(sql);
      if (index === 0) {
        const columns = this.#db.query('PRAGMA table_info(map_place)').all() as Array<{
          name: string;
        }>;
        if (!columns.some((column) => column.name === 'tech_provider')) {
          this.#db.exec(
            "ALTER TABLE map_place ADD COLUMN tech_provider TEXT NOT NULL DEFAULT 'DFX.swiss'",
          );
        }
        if (!columns.some((column) => column.name === 'country')) {
          this.#db.exec('ALTER TABLE map_place ADD COLUMN country TEXT');
        }
        if (!columns.some((column) => column.name === 'shop_name')) {
          this.#db.exec('ALTER TABLE map_place ADD COLUMN shop_name TEXT');
        }
        if (!columns.some((column) => column.name === 'last_transaction_at')) {
          this.#db.exec('ALTER TABLE map_place ADD COLUMN last_transaction_at TEXT');
        }
      }
    }
    this.#db.exec(
      "UPDATE map_place SET shop_name = 'SPAR' WHERE origin = 'spar' AND shop_name IS NULL",
    );
    backfillMissingCountry(this.#db);
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
    const country = input.country ?? null;
    const shopName = input.shopName ?? null;
    const supports = storedSupports(input.supports ?? []);
    const result = this.#db
      .query(
        `INSERT INTO map_place (
           id, origin, external_id, name, lat, lon, category, payment_methods, created_at, tech_provider, country, shop_name, last_transaction_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        country,
        shopName,
        null,
      );
    if (result.changes === 1) {
      insertSupportRows(this.#db, id, supports);
      return {
        created: true,
        place: {
          origin: input.origin,
          externalId: input.externalId,
          name: input.name,
          lat: input.lat,
          lon: input.lon,
          category: input.category,
          paymentMethods: input.paymentMethods,
          techProvider,
          country,
          shopName,
          supports: supports.map((item) => ({
            blockchain: item.blockchain,
            asset: item.asset,
          })),
          lastTransactionAt: null,
          id,
          createdAt,
        },
      };
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
    return { created: false, place: mapOne(this.#db, existing) };
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
    const country = input.country ?? null;
    const shopName = input.shopName ?? null;
    this.#db
      .query(
        `UPDATE map_place
         SET name = ?, lat = ?, lon = ?, category = ?, payment_methods = ?, tech_provider = ?, country = ?, shop_name = ?
         WHERE origin = ? AND external_id = ?`,
      )
      .run(
        input.name,
        input.lat,
        input.lon,
        input.category,
        input.paymentMethods,
        techProvider,
        country,
        shopName,
        input.origin,
        input.externalId,
      );
    if (input.supports !== undefined) {
      replaceSupportRows(this.#db, existing.id, storedSupports(input.supports));
    }
    return {
      created: false,
      place: mapOne(this.#db, {
        ...existing,
        name: input.name,
        lat: input.lat,
        lon: input.lon,
        category: input.category,
        payment_methods: input.paymentMethods,
        tech_provider: techProvider,
        country,
        shop_name: shopName,
      }),
    };
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
    const existing = this.#db
      .query(
        `SELECT ${MAP_PLACE_COLUMNS}
         FROM map_place WHERE origin = ? AND external_id = ?`,
      )
      .get(origin, externalId) as MapPlaceRow | null;
    if (existing === null) {
      return undefined;
    }
    const newMs = Date.parse(occurredAt);
    if (!Number.isFinite(newMs)) {
      return mapOne(this.#db, existing);
    }
    const canonical = new Date(newMs).toISOString();
    const storedMs =
      existing.last_transaction_at === null ? Number.NaN : Date.parse(existing.last_transaction_at);
    if (Number.isFinite(storedMs) && storedMs >= newMs) {
      return mapOne(this.#db, existing);
    }
    this.#db
      .query(
        `UPDATE map_place
         SET last_transaction_at = ?
         WHERE origin = ? AND external_id = ?`,
      )
      .run(canonical, origin, externalId);
    return mapOne(this.#db, { ...existing, last_transaction_at: canonical });
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
   * Newest pins first, then id descending.
   *
   * @param limit - Maximum rows.
   * @param filter - Optional AND predicates, applied before sort and limit.
   * @returns Stored pins.
   */
  list(limit: number, filter?: MapPlaceListFilter): StoredMapPlace[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.origin !== undefined) {
      where.push('origin = ?');
      params.push(filter.origin);
    }
    if (filter?.country !== undefined) {
      where.push('country = ?');
      params.push(filter.country);
    }
    if (filter?.shopName === 'SPAR') {
      where.push('shop_name = ?');
      params.push('SPAR');
    } else if (filter?.shopName === 'others') {
      where.push('(shop_name IS NULL OR shop_name <> ?)');
      params.push('SPAR');
    }
    if (filter !== undefined && (filter.blockchain !== undefined || filter.asset !== undefined)) {
      const payment = unstatedPaymentSql(filter.blockchain, filter.asset);
      if (payment !== null) {
        where.push(payment.sql);
        params.push(...payment.params);
      } else if (filter.blockchain !== undefined && filter.asset !== undefined) {
        where.push(
          'id IN (SELECT place_id FROM map_place_support WHERE blockchain = ? AND asset = ?)',
        );
        params.push(filter.blockchain, filter.asset);
      } else if (filter.blockchain !== undefined) {
        where.push('id IN (SELECT place_id FROM map_place_support WHERE blockchain = ?)');
        params.push(filter.blockchain);
      } else if (filter.asset !== undefined) {
        where.push('id IN (SELECT place_id FROM map_place_support WHERE asset = ?)');
        params.push(filter.asset);
      }
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.#db
      .query(
        `SELECT ${MAP_PLACE_COLUMNS}
         FROM map_place
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit) as MapPlaceRow[];
    return mapRows(this.#db, rows);
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
    const countryRows = this.#db
      .query(
        `SELECT DISTINCT country
         FROM map_place
         WHERE country IS NOT NULL
         ORDER BY country`,
      )
      .all() as Array<{ country: string }>;
    const blockchainRows = this.#db
      .query(
        `SELECT DISTINCT blockchain
         FROM map_place_support
         ORDER BY blockchain`,
      )
      .all() as Array<{ blockchain: string }>;
    const assetRows =
      blockchain === undefined
        ? (this.#db
            .query(
              `SELECT DISTINCT asset
               FROM map_place_support
               ORDER BY asset`,
            )
            .all() as Array<{ asset: string }>)
        : (this.#db
            .query(
              `SELECT DISTINCT asset
               FROM map_place_support
               WHERE blockchain = ?
               ORDER BY asset`,
            )
            .all(blockchain) as Array<{ asset: string }>);
    return {
      countries: countryRows.map((row) => row.country),
      blockchains: blockchainRows.map((row) => row.blockchain),
      assets: assetRows.map((row) => row.asset),
    };
  }

  /** Close the database. */
  close(): void {
    this.#db.close();
  }
}
