import { Database } from 'bun:sqlite';
import { unstatedPaymentSql } from '@/lib/map/filter-catalog';
import {
  placeActivity,
  type MapPlaceInput,
  type MapPlaceSupport,
  type PlaceActivity,
  type ShopType,
  type StoredMapPlace,
} from '@/lib/map/place';
import { MAP_PLACE_SCHEMA_SQL, type MapPlaceListFilter, type MapPlaceStore } from '@/lib/map/store';

const MAP_PLACE_COLUMNS =
  'id, origin, external_id, name, description, lat, lon, category, payment_methods, created_at, tech_provider, country, street, house_number, postal_code, city, shop_type, last_transaction_at, activity';

/** SQL predicate: a row is complete and may appear in GET /map/places and countries. */
const COMPLETE_PLACE_SQL = `(name IS NOT NULL AND name != ''
  AND description IS NOT NULL AND description != ''
  AND shop_type IN ('SPAR', 'Others')
  AND street IS NOT NULL AND street != ''
  AND house_number IS NOT NULL AND house_number != ''
  AND postal_code IS NOT NULL AND postal_code != ''
  AND city IS NOT NULL AND city != ''
  AND country IS NOT NULL AND country != ''
  AND (last_transaction_at IS NULL OR julianday(last_transaction_at) IS NOT NULL))`;

const SUPPORT_ID_CHUNK = 500;

type MapPlaceRow = {
  id: string;
  origin: string;
  external_id: string;
  name: string;
  description: string | null;
  lat: number;
  lon: number;
  category: string;
  payment_methods: string | null;
  created_at: string;
  tech_provider: string;
  country: string | null;
  street: string | null;
  house_number: string | null;
  postal_code: string | null;
  city: string | null;
  shop_type: string | null;
  last_transaction_at: string | null;
  activity: PlaceActivity;
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

function asShopType(value: string | null): ShopType {
  if (value === 'SPAR' || value === 'Others') {
    return value;
  }
  return 'Others';
}

function mapRow(row: MapPlaceRow, supports: MapPlaceSupport[]): StoredMapPlace {
  return {
    id: row.id,
    origin: row.origin,
    externalId: row.external_id,
    name: row.name,
    description: row.description ?? '',
    lat: row.lat,
    lon: row.lon,
    category: row.category,
    paymentMethods: row.payment_methods,
    createdAt: row.created_at,
    techProvider: row.tech_provider,
    country: row.country ?? '',
    street: row.street ?? '',
    houseNumber: row.house_number ?? '',
    postalCode: row.postal_code ?? '',
    city: row.city ?? '',
    shopType: asShopType(row.shop_type),
    lastTransactionAt: row.last_transaction_at,
    activity: row.activity,
    supports: supports.map((item) => ({ blockchain: item.blockchain, asset: item.asset })),
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

function loadPaymentDays(db: Database, placeId: string): string[] {
  const rows = db
    .query('SELECT day FROM map_place_payment_day WHERE place_id = ? ORDER BY day')
    .all(placeId) as Array<{ day: string }>;
  return rows.map((row) => row.day);
}

function loadSupportsByPlaceId(db: Database, ids: string[]): Map<string, MapPlaceSupport[]> {
  const supportsById = new Map<string, MapPlaceSupport[]>();
  for (const id of ids) {
    supportsById.set(id, []);
  }
  if (ids.length === 0) {
    return supportsById;
  }
  for (let start = 0; start < ids.length; start += SUPPORT_ID_CHUNK) {
    const chunk = ids.slice(start, start + SUPPORT_ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .query(
        `SELECT place_id, blockchain, asset
         FROM map_place_support
         WHERE place_id IN (${placeholders})
         ORDER BY blockchain, asset`,
      )
      .all(...chunk) as Array<{ place_id: string; blockchain: string; asset: string }>;
    for (const row of rows) {
      const list = supportsById.get(row.place_id);
      if (list === undefined) {
        throw new Error('map place support for unknown id');
      }
      list.push({ blockchain: row.blockchain, asset: row.asset });
    }
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

function backfillActivityFromLastTransaction(db: Database): void {
  const nowMs = Date.now();
  const rows = db.query('SELECT id, last_transaction_at FROM map_place').all() as Array<{
    id: string;
    last_transaction_at: string | null;
  }>;
  const insertDay = db.query(
    'INSERT OR IGNORE INTO map_place_payment_day (place_id, day) VALUES (?, ?)',
  );
  const update = db.query('UPDATE map_place SET activity = ?, activity_until = ? WHERE id = ?');
  for (const row of rows) {
    const days: string[] = [];
    const last = row.last_transaction_at;
    const parsed = last === null ? Number.NaN : Date.parse(last);
    if (Number.isFinite(parsed)) {
      const day = utcDayFromMs(parsed);
      if (paymentDayInWindow(day, nowMs)) {
        insertDay.run(row.id, day);
        days.push(day);
      }
    }
    const classified = placeActivity(last, days, nowMs);
    update.run(classified.activity, classified.until, row.id);
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
 * Insert, list, delete, and a full-replace upsert are exercised by the HTTP
 * end-to-end run.
 * Opening an old-schema file (shop_name present, description and shop_type
 * missing) and hiding incomplete rows is exercised by e2e/sqlite-backfill.ts.
 * It also checks that listAll returns incomplete rows, and that supports load in
 * chunks for more than 500 places.
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
    let addedActivity = false;
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
        if (!columns.some((column) => column.name === 'street')) {
          this.#db.exec('ALTER TABLE map_place ADD COLUMN street TEXT');
        }
        if (!columns.some((column) => column.name === 'house_number')) {
          this.#db.exec('ALTER TABLE map_place ADD COLUMN house_number TEXT');
        }
        if (!columns.some((column) => column.name === 'postal_code')) {
          this.#db.exec('ALTER TABLE map_place ADD COLUMN postal_code TEXT');
        }
        if (!columns.some((column) => column.name === 'city')) {
          this.#db.exec('ALTER TABLE map_place ADD COLUMN city TEXT');
        }
        if (!columns.some((column) => column.name === 'description')) {
          this.#db.exec('ALTER TABLE map_place ADD COLUMN description TEXT');
        }
        if (!columns.some((column) => column.name === 'shop_type')) {
          this.#db.exec('ALTER TABLE map_place ADD COLUMN shop_type TEXT');
        }
        if (!columns.some((column) => column.name === 'last_transaction_at')) {
          this.#db.exec('ALTER TABLE map_place ADD COLUMN last_transaction_at TEXT');
        }
        if (!columns.some((column) => column.name === 'activity')) {
          this.#db.exec("ALTER TABLE map_place ADD COLUMN activity TEXT NOT NULL DEFAULT 'none'");
          addedActivity = true;
        }
        if (!columns.some((column) => column.name === 'activity_until')) {
          this.#db.exec('ALTER TABLE map_place ADD COLUMN activity_until TEXT');
        }
      }
    }
    if (addedActivity) {
      backfillActivityFromLastTransaction(this.#db);
    }
    this.refreshActivity(Date.now());
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
    const supports = storedSupports(input.supports);
    const result = this.#db
      .query(
        `INSERT INTO map_place (
           id, origin, external_id, name, description, lat, lon, category, payment_methods,
           created_at, tech_provider, country, street, house_number, postal_code, city,
           shop_type, last_transaction_at, activity, activity_until
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (origin, external_id) DO NOTHING`,
      )
      .run(
        id,
        input.origin,
        input.externalId,
        input.name,
        input.description,
        input.lat,
        input.lon,
        input.category,
        input.paymentMethods,
        createdAt,
        techProvider,
        input.country,
        input.street,
        input.houseNumber,
        input.postalCode,
        input.city,
        input.shopType,
        null,
        'none',
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
          description: input.description,
          lat: input.lat,
          lon: input.lon,
          category: input.category,
          paymentMethods: input.paymentMethods,
          techProvider,
          country: input.country,
          street: input.street,
          houseNumber: input.houseNumber,
          postalCode: input.postalCode,
          city: input.city,
          shopType: input.shopType,
          supports: supports.map((item) => ({
            blockchain: item.blockchain,
            asset: item.asset,
          })),
          lastTransactionAt: null,
          activity: 'none',
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
   * Insert when the pair is new, otherwise replace every field of the stored pin.
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
    const techProvider = input.techProvider ?? 'DFX.swiss';
    const supports = storedSupports(input.supports);
    this.#db
      .query(
        `UPDATE map_place
         SET name = ?, description = ?, lat = ?, lon = ?, category = ?, payment_methods = ?,
             tech_provider = ?, country = ?, street = ?, house_number = ?, postal_code = ?,
             city = ?, shop_type = ?
         WHERE origin = ? AND external_id = ?`,
      )
      .run(
        input.name,
        input.description,
        input.lat,
        input.lon,
        input.category,
        input.paymentMethods,
        techProvider,
        input.country,
        input.street,
        input.houseNumber,
        input.postalCode,
        input.city,
        input.shopType,
        input.origin,
        input.externalId,
      );
    replaceSupportRows(this.#db, existing.id, supports);
    return {
      created: false,
      place: mapOne(this.#db, {
        ...existing,
        name: input.name,
        description: input.description,
        lat: input.lat,
        lon: input.lon,
        category: input.category,
        payment_methods: input.paymentMethods,
        tech_provider: techProvider,
        country: input.country,
        street: input.street,
        house_number: input.houseNumber,
        postal_code: input.postalCode,
        city: input.city,
        shop_type: input.shopType,
      }),
    };
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
    let lastTransactionAt = existing.last_transaction_at;
    if (!Number.isFinite(storedMs) || storedMs < newMs) {
      lastTransactionAt = canonical;
      this.#db
        .query(
          `UPDATE map_place
           SET last_transaction_at = ?
           WHERE origin = ? AND external_id = ?`,
        )
        .run(canonical, origin, externalId);
    }
    const start = windowStartDay(nowMs);
    this.#db
      .query('DELETE FROM map_place_payment_day WHERE place_id = ? AND day < ?')
      .run(existing.id, start);
    const day = utcDayFromMs(newMs);
    if (paymentDayInWindow(day, nowMs)) {
      this.#db
        .query('INSERT OR IGNORE INTO map_place_payment_day (place_id, day) VALUES (?, ?)')
        .run(existing.id, day);
    }
    const days = loadPaymentDays(this.#db, existing.id);
    const classified = placeActivity(lastTransactionAt, days, nowMs);
    this.#db
      .query('UPDATE map_place SET activity = ?, activity_until = ? WHERE id = ?')
      .run(classified.activity, classified.until, existing.id);
    return mapOne(this.#db, {
      ...existing,
      last_transaction_at: lastTransactionAt,
      activity: classified.activity,
    });
  }

  /**
   * Recompute activity for rows whose stored `activity_until` is due.
   *
   * @param nowMs - Maintenance clock in milliseconds.
   */
  refreshActivity(nowMs: number): void {
    const nowIso = new Date(nowMs).toISOString();
    const start = windowStartDay(nowMs);
    const due = this.#db
      .query(
        `SELECT ${MAP_PLACE_COLUMNS}
         FROM map_place
         WHERE activity_until IS NOT NULL AND activity_until <= ?`,
      )
      .all(nowIso) as MapPlaceRow[];
    const deleteOldDays = this.#db.query(
      'DELETE FROM map_place_payment_day WHERE place_id = ? AND day < ?',
    );
    const update = this.#db.query(
      'UPDATE map_place SET activity = ?, activity_until = ? WHERE id = ?',
    );
    for (const row of due) {
      deleteOldDays.run(row.id, start);
      const classified = placeActivity(
        row.last_transaction_at,
        loadPaymentDays(this.#db, row.id),
        nowMs,
      );
      update.run(classified.activity, classified.until, row.id);
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
    const result = this.#db
      .query('DELETE FROM map_place WHERE origin = ? AND external_id = ?')
      .run(origin, externalId);
    return result.changes > 0;
  }

  /**
   * Newest complete pins first, then id descending.
   *
   * @param limit - Maximum rows.
   * @param filter - Optional AND predicates, applied before sort and limit.
   * @returns Stored pins.
   */
  list(limit: number, filter?: MapPlaceListFilter): StoredMapPlace[] {
    const where: string[] = [COMPLETE_PLACE_SQL];
    const params: Array<string | number> = [];
    if (filter?.origin !== undefined) {
      where.push('origin = ?');
      params.push(filter.origin);
    }
    if (filter?.country !== undefined) {
      where.push('country = ?');
      params.push(filter.country);
    }
    if (filter?.shopType !== undefined) {
      where.push('shop_type = ?');
      params.push(filter.shopType);
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
    const whereSql = `WHERE ${where.join(' AND ')}`;
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
   * Every stored pin, including incomplete ones. Newest first, then id descending.
   *
   * @returns Stored pins. No filter and no limit.
   */
  listAll(): StoredMapPlace[] {
    const rows = this.#db
      .query(
        `SELECT ${MAP_PLACE_COLUMNS}
         FROM map_place
         ORDER BY created_at DESC, id DESC`,
      )
      .all() as MapPlaceRow[];
    return mapRows(this.#db, rows);
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
    const countryRows = this.#db
      .query(
        `SELECT DISTINCT country
         FROM map_place
         WHERE ${COMPLETE_PLACE_SQL}
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
