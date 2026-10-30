import { Database, SQLiteError } from 'bun:sqlite';
import googleMapsSeed from '@/lib/map/google-maps-seed.json' with { type: 'json' };
import { unstatedPaymentSql } from '@/lib/map/filter-catalog';
import { npubDecode } from '@/lib/map/nostr-key';
import type { PreparedPhoto } from '@/lib/map/photo';
import type { PhotoType } from '@/lib/map/photo-strip';
import {
  isGoogleMapsUrl,
  placeActivity,
  type MapPlaceInput,
  type MapPlaceSupport,
  type PlaceActivity,
  type ShopType,
  type StoredMapPlace,
  type StoredPlacePhoto,
} from '@/lib/map/place';
import {
  MAP_PLACE_SCHEMA_SQL,
  placeNameConflict,
  placeWriteConflict,
  type MapPhotoFile,
  type MapPhotoWriteResult,
  type MapPlaceDeleteResult,
  type MapPlaceListFilter,
  type MapPlaceStore,
  type MapPlaceWriteResult,
  type ReplaceByIdInput,
  type ReplaceByIdResult,
} from '@/lib/map/store';

const MAP_PLACE_COLUMNS =
  'id, origin, external_id, name, description, lat, lon, category, payment_methods, created_at, tech_provider, country, street, house_number, postal_code, city, shop_type, last_transaction_at, activity, nostr_pubkey, active, google_maps_url';

/** SQL predicate: a row is complete. Public reads also require `active` = 1. */
const COMPLETE_PLACE_SQL = `(name IS NOT NULL AND name != ''
  AND description IS NOT NULL AND description != ''
  AND shop_type IN ('SPAR', 'Others')
  AND street IS NOT NULL AND street != ''
  AND house_number IS NOT NULL AND house_number != ''
  AND postal_code IS NOT NULL AND postal_code != ''
  AND city IS NOT NULL AND city != ''
  AND country IS NOT NULL AND country != ''
  AND nostr_pubkey IS NOT NULL
  AND (last_transaction_at IS NULL OR julianday(last_transaction_at) IS NOT NULL))`;

/** A complete row that is shown. Public list, detail, photo, and countries. */
const PUBLIC_PLACE_SQL = `(${COMPLETE_PLACE_SQL} AND active = 1)`;

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
  nostr_pubkey: string | null;
  active: number;
  google_maps_url: string | null;
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

function mapRow(
  row: MapPlaceRow,
  supports: MapPlaceSupport[],
  photos: StoredPlacePhoto[],
): StoredMapPlace {
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
    active: row.active === 1,
    googleMapsUrl: row.google_maps_url,
    nostrPubkey: row.nostr_pubkey,
    supports: supports.map((item) => ({ blockchain: item.blockchain, asset: item.asset })),
    photos,
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

function loadPhotosByPlaceId(db: Database, ids: string[]): Map<string, StoredPlacePhoto[]> {
  const photosById = new Map<string, StoredPlacePhoto[]>();
  for (const id of ids) {
    photosById.set(id, []);
  }
  for (let start = 0; start < ids.length; start += SUPPORT_ID_CHUNK) {
    const chunk = ids.slice(start, start + SUPPORT_ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .query(
        `SELECT pp.place_id, pp.sha256, pp.caption, p.content_type, p.width, p.height
         FROM map_place_photo pp JOIN map_photo p ON p.sha256 = pp.sha256
         WHERE pp.place_id IN (${placeholders})
         ORDER BY pp.position`,
      )
      .all(...chunk) as Array<{
      place_id: string;
      sha256: string;
      caption: string | null;
      content_type: PhotoType;
      width: number;
      height: number;
    }>;
    for (const row of rows) {
      photosById.get(row.place_id)?.push({
        sha256: row.sha256,
        contentType: row.content_type,
        width: row.width,
        height: row.height,
        caption: row.caption,
      });
    }
  }
  return photosById;
}

function mapRows(db: Database, rows: MapPlaceRow[]): StoredMapPlace[] {
  const ids = rows.map((row) => row.id);
  const supportsById = loadSupportsByPlaceId(db, ids);
  const photosById = loadPhotosByPlaceId(db, ids);
  return rows.map((row) => {
    const supports = supportsById.get(row.id);
    if (supports === undefined) {
      throw new Error('map place supports missing');
    }
    return mapRow(row, supports, photosById.get(row.id) ?? []);
  });
}

function dropUnusedPhotos(db: Database): void {
  db.query('DELETE FROM map_photo WHERE sha256 NOT IN (SELECT sha256 FROM map_place_photo)').run();
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

function seedGoogleMapsUrls(db: Database): void {
  const update = db.query(
    'UPDATE map_place SET google_maps_url = ? WHERE nostr_pubkey = ? AND google_maps_url IS NULL',
  );
  for (const entry of googleMapsSeed) {
    const pubkey = npubDecode(entry.npub);
    if (pubkey === null) {
      continue;
    }
    if (!isGoogleMapsUrl(entry.googleMapsUrl)) {
      continue;
    }
    update.run(entry.googleMapsUrl, pubkey);
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
 * Insert, list, delete, a full-replace upsert, and replace-by-id are exercised
 * by the HTTP end-to-end run.
 * Opening an old-schema file (shop_name present, description and shop_type
 * missing) and hiding incomplete rows is exercised by e2e/sqlite-backfill.ts.
 * It also checks that listAll returns incomplete rows, that supports load in
 * chunks for more than 500 places, the key and revision rules (R7, R8), photos,
 * and the key rules of replace-by-id and delete-by-id.
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
        if (!columns.some((column) => column.name === 'nostr_pubkey')) {
          this.#db.exec('ALTER TABLE map_place ADD COLUMN nostr_pubkey TEXT');
        }
        if (!columns.some((column) => column.name === 'active')) {
          this.#db.exec('ALTER TABLE map_place ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
        }
        if (!columns.some((column) => column.name === 'google_maps_url')) {
          // The column marks the seed as done, so both commit together or not at all.
          this.#db.transaction(() => {
            this.#db.exec('ALTER TABLE map_place ADD COLUMN google_maps_url TEXT');
            seedGoogleMapsUrls(this.#db);
          })();
        }
      }
    }
    if (addedActivity) {
      backfillActivityFromLastTransaction(this.#db);
    }
    this.refreshActivity(Date.now());
  }

  /**
   * Insert when the pair is new. An existing pair is returned unchanged, except
   * that a row without a key stores the key this write carries. A repeat does
   * not change the Google Maps link. A new pair whose exact name another row
   * stores is refused and stores nothing. An existing pair does not check the name.
   *
   * @param input - Validated pin.
   * @param revision - Request revision (R8), when sent.
   * @returns Whether this call inserted the row, or the 409 text.
   */
  insertIfNew(input: MapPlaceInput, revision?: number): MapPlaceWriteResult {
    return this.#db.transaction(() => this.#write(input, revision, false))();
  }

  /**
   * Insert when the pair is new, otherwise replace the pin's content (name, description,
   * position, category, payment methods, tech provider, shop type, address, supports).
   * The Google Maps link is written only when the pin carries that property.
   * The id, photos, timestamps, activity, and active flag stay, and the stored revision
   * changes only when one is sent. A stored key is kept; a row without a key stores the key
   * this write carries. A new or replacing write whose exact name another row stores is
   * refused and leaves any existing row unchanged.
   *
   * @param input - Validated pin.
   * @param revision - Request revision (R8), when sent.
   * @returns Whether this call inserted the row, or the 409 text.
   */
  upsert(input: MapPlaceInput, revision?: number): MapPlaceWriteResult {
    return this.#db.transaction(() => this.#write(input, revision, true))();
  }

  /**
   * First id that stores this exact name. A row other than `selfId` wins, so a
   * name already shared with another row is refused. The match is SQLite's
   * default binary comparison: no COLLATE NOCASE and no unique index.
   *
   * @param name - Exact name the write would store.
   * @param selfId - Id of the row being written, or null on insert.
   * @returns That id, the row's own id when it is the only match, or null.
   */
  #nameOwnerId(name: string, selfId: string | null): string | null {
    const rows = this.#db.query('SELECT id FROM map_place WHERE name = ?').all(name) as Array<{
      id: string;
    }>;
    let own: string | null = null;
    for (const row of rows) {
      if (selfId !== null && row.id === selfId) {
        own = row.id;
        continue;
      }
      return row.id;
    }
    return own;
  }

  #storedRevision(origin: string, externalId: string): number | undefined {
    const row = this.#db
      .query('SELECT revision FROM map_place_revision WHERE origin = ? AND external_id = ?')
      .get(origin, externalId) as { revision: number } | null;
    return row === null ? undefined : row.revision;
  }

  #storeRevision(origin: string, externalId: string, revision: number | undefined): void {
    if (revision === undefined) {
      return;
    }
    this.#db
      .query(
        `INSERT INTO map_place_revision (origin, external_id, revision) VALUES (?, ?, ?)
         ON CONFLICT (origin, external_id) DO UPDATE SET revision = excluded.revision`,
      )
      .run(origin, externalId, revision);
  }

  #write(
    input: MapPlaceInput,
    revision: number | undefined,
    replace: boolean,
  ): MapPlaceWriteResult {
    const existing = this.#db
      .query(
        `SELECT ${MAP_PLACE_COLUMNS}
         FROM map_place WHERE origin = ? AND external_id = ?`,
      )
      .get(input.origin, input.externalId) as MapPlaceRow | null;
    const key = input.nostrPubkey;
    const reservation =
      key === undefined
        ? null
        : (this.#db
            .query('SELECT origin, external_id FROM map_pubkey_reservation WHERE nostr_pubkey = ?')
            .get(key) as { origin: string; external_id: string } | null);
    const conflict = placeWriteConflict({
      storedRevision: this.#storedRevision(input.origin, input.externalId),
      revision,
      rowExists: existing !== null,
      storedKey: existing?.nostr_pubkey ?? null,
      key,
      reservedFor:
        reservation === null
          ? undefined
          : { origin: reservation.origin, externalId: reservation.external_id },
      origin: input.origin,
      externalId: input.externalId,
    });
    if (conflict !== null) {
      return { ok: false, error: conflict };
    }
    // A repeat insert keeps the stored name, so a foreign name in the payload is not a conflict.
    if (replace || existing === null) {
      const selfId = existing === null ? null : existing.id;
      const nameConflict = placeNameConflict(this.#nameOwnerId(input.name, selfId), selfId);
      if (nameConflict !== null) {
        return { ok: false, error: nameConflict };
      }
    }
    if (key !== undefined && reservation === null) {
      this.#db
        .query(
          `INSERT INTO map_pubkey_reservation (nostr_pubkey, origin, external_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(key, input.origin, input.externalId, new Date().toISOString());
    }
    this.#storeRevision(input.origin, input.externalId, revision);
    const techProvider = input.techProvider ?? 'DFX.swiss';
    const supports = storedSupports(input.supports);
    if (existing === null) {
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      this.#db
        .query(
          `INSERT INTO map_place (
             id, origin, external_id, name, description, lat, lon, category, payment_methods,
             created_at, tech_provider, country, street, house_number, postal_code, city,
             shop_type, last_transaction_at, activity, activity_until, nostr_pubkey, active,
             google_maps_url
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          key ?? null,
          1,
          input.googleMapsUrl === undefined ? null : input.googleMapsUrl,
        );
      insertSupportRows(this.#db, id, supports);
      return {
        ok: true,
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
          photos: [],
          nostrPubkey: key ?? null,
          lastTransactionAt: null,
          activity: 'none',
          active: true,
          googleMapsUrl: input.googleMapsUrl === undefined ? null : input.googleMapsUrl,
          id,
          createdAt,
        },
      };
    }
    const nostrPubkey = existing.nostr_pubkey ?? key ?? null;
    if (existing.nostr_pubkey === null && key !== undefined) {
      this.#db.query('UPDATE map_place SET nostr_pubkey = ? WHERE id = ?').run(key, existing.id);
    }
    if (!replace) {
      return {
        ok: true,
        created: false,
        place: mapOne(this.#db, { ...existing, nostr_pubkey: nostrPubkey }),
      };
    }
    this.#db
      .query(
        `UPDATE map_place
         SET name = ?, description = ?, lat = ?, lon = ?, category = ?, payment_methods = ?,
             tech_provider = ?, country = ?, street = ?, house_number = ?, postal_code = ?,
             city = ?, shop_type = ?
         WHERE id = ?`,
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
        existing.id,
      );
    replaceSupportRows(this.#db, existing.id, supports);
    if (input.googleMapsUrl !== undefined) {
      this.#db
        .query('UPDATE map_place SET google_maps_url = ? WHERE id = ?')
        .run(input.googleMapsUrl, existing.id);
    }
    return {
      ok: true,
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
        nostr_pubkey: nostrPubkey,
        google_maps_url:
          input.googleMapsUrl === undefined ? existing.google_maps_url : input.googleMapsUrl,
      }),
    };
  }

  /**
   * Replace every stored fact of one internal id except the id, a stored key, the photos, the
   * payment days and the pair's revision.
   * Runs in one transaction. A missing id writes nothing.
   * Another row with this origin and caller id writes nothing.
   * A key follows R7 against the new pair, and the row's key reservation moves
   * to it. Another row with this exact name writes nothing. The row's own name
   * is allowed. Revisions (R8) are neither checked nor stored.
   * A UNIQUE failure rolls back, including support rows, and returns conflict.
   * `activity_until` is updated here even though it is not in `MAP_PLACE_COLUMNS`.
   * `active` is written on every replace. The Google Maps link is written only
   * when the content carries that property.
   *
   * @param input - Id, validated pin, timestamps, activity write, and clock.
   * @returns The stored row when updated, otherwise missing, conflict, or
   * `{ status: 'keyConflict', error }` with the R7 text or
   * `Place name belongs to another place`.
   */
  replaceById(input: ReplaceByIdInput): ReplaceByIdResult {
    const techProvider = input.content.techProvider ?? 'DFX.swiss';
    const supports = storedSupports(input.content.supports);
    const apply = this.#db.transaction((): ReplaceByIdResult => {
      const existing = this.#db
        .query(
          `SELECT ${MAP_PLACE_COLUMNS}
           FROM map_place WHERE id = ?`,
        )
        .get(input.id) as MapPlaceRow | null;
      if (existing === null) {
        return { status: 'missing' };
      }
      const other = this.#db
        .query('SELECT id FROM map_place WHERE origin = ? AND external_id = ? AND id != ?')
        .get(input.content.origin, input.content.externalId, input.id) as { id: string } | null;
      if (other !== null) {
        return { status: 'conflict' };
      }
      const key = input.content.nostrPubkey;
      const reservation =
        key === undefined
          ? null
          : (this.#db
              .query(
                'SELECT origin, external_id FROM map_pubkey_reservation WHERE nostr_pubkey = ?',
              )
              .get(key) as { origin: string; external_id: string } | null);
      const keyConflict = placeWriteConflict({
        storedRevision: undefined,
        revision: undefined,
        rowExists: true,
        storedKey: existing.nostr_pubkey,
        key,
        reservedFor:
          reservation === null
            ? undefined
            : { origin: reservation.origin, externalId: reservation.external_id },
        origin: input.content.origin,
        externalId: input.content.externalId,
      });
      if (keyConflict !== null) {
        return { status: 'keyConflict', error: keyConflict };
      }
      const nameConflict = placeNameConflict(
        this.#nameOwnerId(input.content.name, existing.id),
        existing.id,
      );
      if (nameConflict !== null) {
        return { status: 'keyConflict', error: nameConflict };
      }
      const nostrPubkey = existing.nostr_pubkey ?? key ?? null;
      if (nostrPubkey !== null) {
        this.#db
          .query(
            `INSERT INTO map_pubkey_reservation (nostr_pubkey, origin, external_id, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (nostr_pubkey) DO UPDATE
             SET origin = excluded.origin, external_id = excluded.external_id`,
          )
          .run(
            nostrPubkey,
            input.content.origin,
            input.content.externalId,
            new Date().toISOString(),
          );
      }
      // activity_until is not selected with MAP_PLACE_COLUMNS. keep leaves it.
      const activitySql =
        input.activity.kind === 'keep' ? '' : ', activity = ?, activity_until = ?';
      const params: Array<string | number | null> = [
        input.content.origin,
        input.content.externalId,
        input.content.name,
        input.content.description,
        input.content.lat,
        input.content.lon,
        input.content.category,
        input.content.paymentMethods,
        techProvider,
        input.content.country,
        input.content.street,
        input.content.houseNumber,
        input.content.postalCode,
        input.content.city,
        input.content.shopType,
        input.createdAt,
        input.lastTransactionAt,
        nostrPubkey,
        input.active ? 1 : 0,
      ];
      if (input.activity.kind === 'set') {
        params.push(input.activity.activity, null);
      } else if (input.activity.kind === 'recompute') {
        const classified = placeActivity(
          input.lastTransactionAt,
          loadPaymentDays(this.#db, existing.id),
          input.nowMs,
        );
        params.push(classified.activity, classified.until);
      }
      params.push(input.id);
      this.#db
        .query(
          `UPDATE map_place
           SET origin = ?, external_id = ?, name = ?, description = ?, lat = ?, lon = ?,
               category = ?, payment_methods = ?, tech_provider = ?, country = ?, street = ?,
               house_number = ?, postal_code = ?, city = ?, shop_type = ?, created_at = ?,
               last_transaction_at = ?, nostr_pubkey = ?, active = ?${activitySql}
           WHERE id = ?`,
        )
        .run(...params);
      replaceSupportRows(this.#db, existing.id, supports);
      if (input.content.googleMapsUrl !== undefined) {
        this.#db
          .query('UPDATE map_place SET google_maps_url = ? WHERE id = ?')
          .run(input.content.googleMapsUrl, existing.id);
      }
      const updated = this.#db
        .query(
          `SELECT ${MAP_PLACE_COLUMNS}
           FROM map_place WHERE id = ?`,
        )
        .get(input.id) as MapPlaceRow | null;
      if (updated === null) {
        throw new Error('map place replace missing row');
      }
      return { status: 'updated', place: mapOne(this.#db, updated) };
    });
    try {
      return apply();
    } catch (error: unknown) {
      if (error instanceof SQLiteError && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return { status: 'conflict' };
      }
      throw error;
    }
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
   * Remove the pin for this origin and external id. The pair's key reservations
   * and revision stay.
   *
   * @param origin - Pin origin.
   * @param externalId - Caller id.
   * @param revision - Request revision (R8), when sent. Stored also when no row matched.
   * @returns Whether a row was removed, or `Stale revision`.
   */
  deleteByKey(origin: string, externalId: string, revision?: number): MapPlaceDeleteResult {
    return this.#db.transaction((): MapPlaceDeleteResult => {
      const stored = this.#storedRevision(origin, externalId);
      if (stored !== undefined && (revision === undefined || revision <= stored)) {
        return { ok: false, error: 'Stale revision' };
      }
      this.#storeRevision(origin, externalId, revision);
      const result = this.#db
        .query('DELETE FROM map_place WHERE origin = ? AND external_id = ?')
        .run(origin, externalId);
      dropUnusedPhotos(this.#db);
      return { ok: true, deleted: result.changes > 0 };
    })();
  }

  /**
   * Replace every photo of the stored place with this key and origin, listed or
   * not, in one transaction. Files no place uses any more are deleted.
   *
   * @param origin - Origin that registered the place.
   * @param nostrPubkey - The place's key.
   * @param photos - Prepared photos in display order.
   * @param revision - Request revision (R8), when sent; it shares the place's counter.
   * @returns The stored photo list, `Place not found`, or `Stale revision`.
   */
  replacePhotos(
    origin: string,
    nostrPubkey: string,
    photos: PreparedPhoto[],
    revision?: number,
  ): MapPhotoWriteResult {
    return this.#db.transaction((): MapPhotoWriteResult => {
      const row = this.#db
        .query('SELECT id, external_id FROM map_place WHERE nostr_pubkey = ? AND origin = ?')
        .get(nostrPubkey, origin) as { id: string; external_id: string } | null;
      if (row === null) {
        return { ok: false, error: 'Place not found' };
      }
      const stored = this.#storedRevision(origin, row.external_id);
      if (stored !== undefined && (revision === undefined || revision <= stored)) {
        return { ok: false, error: 'Stale revision' };
      }
      this.#storeRevision(origin, row.external_id, revision);
      this.#db.query('DELETE FROM map_place_photo WHERE place_id = ?').run(row.id);
      const insertFile = this.#db.query(
        `INSERT OR IGNORE INTO map_photo (sha256, content_type, width, height, data)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const insertRef = this.#db.query(
        'INSERT INTO map_place_photo (place_id, position, sha256, caption) VALUES (?, ?, ?, ?)',
      );
      for (const [position, photo] of photos.entries()) {
        insertFile.run(photo.sha256, photo.contentType, photo.width, photo.height, photo.data);
        insertRef.run(row.id, position, photo.sha256, photo.caption);
      }
      dropUnusedPhotos(this.#db);
      return {
        ok: true,
        photos: photos.map((photo) => ({
          sha256: photo.sha256,
          contentType: photo.contentType,
          width: photo.width,
          height: photo.height,
          caption: photo.caption,
        })),
      };
    })();
  }

  /**
   * A photo file that a public place uses.
   *
   * @param sha256 - Hash of the stripped bytes.
   * @returns The file, or undefined when no public place shows it.
   */
  findPublicPhoto(sha256: string): MapPhotoFile | undefined {
    const row = this.#db
      .query(
        `SELECT content_type, data FROM map_photo
         WHERE sha256 = ? AND sha256 IN (
           SELECT sha256 FROM map_place_photo
           WHERE place_id IN (SELECT id FROM map_place WHERE ${PUBLIC_PLACE_SQL})
         )`,
      )
      .get(sha256) as { content_type: PhotoType; data: Uint8Array } | null;
    return row === null ? undefined : { contentType: row.content_type, data: row.data };
  }

  /**
   * The public pin that carries this key.
   *
   * @param pubkey - 64 lowercase hex characters.
   * @returns The row, or undefined when no public row has the key.
   */
  findPublicByPubkey(pubkey: string): StoredMapPlace | undefined {
    const row = this.#db
      .query(
        `SELECT ${MAP_PLACE_COLUMNS}
         FROM map_place
         WHERE nostr_pubkey = ? AND ${PUBLIC_PLACE_SQL}`,
      )
      .get(pubkey) as MapPlaceRow | null;
    return row === null ? undefined : mapOne(this.#db, row);
  }

  /**
   * Read one pin by its internal id.
   *
   * @param id - Internal id, compared exactly.
   * @returns A copy of the row, or undefined when the id is missing.
   */
  getById(id: string): StoredMapPlace | undefined {
    const row = this.#db
      .query(
        `SELECT ${MAP_PLACE_COLUMNS}
         FROM map_place WHERE id = ?`,
      )
      .get(id) as MapPlaceRow | null;
    if (row === null) {
      return undefined;
    }
    return mapOne(this.#db, row);
  }

  /**
   * Remove the pin with this internal id. Revisions (R8) are neither checked nor
   * stored; the pair's key reservations and revision stay.
   *
   * @param id - Internal id, compared exactly.
   * @returns Whether a row was removed. False when the id is missing.
   */
  deleteById(id: string): boolean {
    return this.#db.transaction((): boolean => {
      const result = this.#db.query('DELETE FROM map_place WHERE id = ?').run(id);
      dropUnusedPhotos(this.#db);
      return result.changes > 0;
    })();
  }

  /**
   * Newest public pins first, then id descending.
   *
   * @param limit - Maximum rows.
   * @param filter - Optional AND predicates, applied before sort and limit.
   * @returns Stored pins.
   */
  list(limit: number, filter?: MapPlaceListFilter): StoredMapPlace[] {
    const where: string[] = [PUBLIC_PLACE_SQL];
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
      /* v8 ignore next 3 -- @preserve a blockchain or asset query always has a predicate */
      if (payment === null) {
        throw new Error('A blockchain or asset filter has no predicate');
      }
      where.push(payment.sql);
      params.push(...payment.params);
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
   * @returns Countries of public rows, plus blockchains and assets from every row.
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
         WHERE ${PUBLIC_PLACE_SQL}
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
