import { matchesUnstatedPayment } from '@/lib/map/filter-catalog';
import type { PreparedPhoto } from '@/lib/map/photo';
import type { PhotoType } from '@/lib/map/photo-strip';
import {
  placeActivity,
  type MapPlaceInput,
  type MapPlaceQueryFilter,
  type MapPlaceSupport,
  type PlaceActivity,
  type StoredMapPlace,
  type StoredPlacePhoto,
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
CREATE UNIQUE INDEX IF NOT EXISTS map_place_nostr_pubkey ON map_place (nostr_pubkey);
CREATE TABLE IF NOT EXISTS map_pubkey_reservation (
  nostr_pubkey TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS map_place_revision (
  origin TEXT NOT NULL,
  external_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (origin, external_id)
);
CREATE TABLE IF NOT EXISTS map_photo (
  sha256 TEXT PRIMARY KEY,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 4096),
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS map_place_photo (
  place_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  sha256 TEXT NOT NULL,
  caption TEXT,
  PRIMARY KEY (place_id, position),
  FOREIGN KEY (place_id) REFERENCES map_place(id) ON DELETE CASCADE,
  FOREIGN KEY (sha256) REFERENCES map_photo(sha256)
)`;

/** Optional AND predicates for `list`, applied before sort and limit. */
export type MapPlaceListFilter = MapPlaceQueryFilter & {
  origin?: string;
};

/** Why a place write changed nothing (R7, R8, exact name). Each is a 409 body text. */
export type MapPlaceWriteError =
  | 'Stale revision'
  | 'nostrPubkey belongs to another place'
  | 'nostrPubkey of a place cannot change'
  | 'Place name belongs to another place';

/** Outcome of `insertIfNew` and `upsert`. */
export type MapPlaceWriteResult =
  { ok: true; created: boolean; place: StoredMapPlace } | { ok: false; error: MapPlaceWriteError };

/** Outcome of `replacePhotos`. */
export type MapPhotoWriteResult =
  | { ok: true; photos: StoredPlacePhoto[] }
  | { ok: false; error: 'Place not found' | 'Stale revision' };

/** A stored photo file served by `GET /map/photos/{sha256}.{ext}`. */
export type MapPhotoFile = { contentType: PhotoType; data: Uint8Array };

/** Outcome of `deleteByKey`. */
export type MapPlaceDeleteResult =
  { ok: true; deleted: boolean } | { ok: false; error: 'Stale revision' };

/**
 * Decide whether a place write is refused, in the order R8 and R7 fix: a stale
 * or missing revision first, then a changed key, then a key reserved for
 * another pair. Both stores call this inside their write, before anything is
 * stored.
 *
 * @param check - The highest stored revision of the pair, the revision sent,
 * whether the pair has a row and that row's key, the key sent, and the pair a
 * sent key is already reserved for.
 * @returns The 409 text, or null when the write may go ahead.
 */
export function placeWriteConflict(check: {
  storedRevision: number | undefined;
  revision: number | undefined;
  rowExists: boolean;
  storedKey: string | null;
  key: string | undefined;
  reservedFor: { origin: string; externalId: string } | undefined;
  origin: string;
  externalId: string;
}): MapPlaceWriteError | null {
  if (
    check.storedRevision !== undefined &&
    (check.revision === undefined || check.revision <= check.storedRevision)
  ) {
    return 'Stale revision';
  }
  if (check.key === undefined) {
    return null;
  }
  if (check.rowExists && check.storedKey !== null) {
    return check.key === check.storedKey ? null : 'nostrPubkey of a place cannot change';
  }
  if (
    check.reservedFor !== undefined &&
    (check.reservedFor.origin !== check.origin || check.reservedFor.externalId !== check.externalId)
  ) {
    return 'nostrPubkey belongs to another place';
  }
  return null;
}

/**
 * Decide whether a stored name blocks this write. The caller has already
 * compared the exact stored text: this function does not trim and does not
 * fold case. It does no I/O.
 *
 * @param ownerId - Id of a row that already stores this exact name, or null.
 * @param selfId - Id of the row being written, or null when the write inserts.
 * @returns The 409 text, or null when the write may store the name.
 */
export function placeNameConflict(
  ownerId: string | null,
  selfId: string | null,
): MapPlaceWriteError | null {
  if (ownerId === null || ownerId === selfId) {
    return null;
  }
  return 'Place name belongs to another place';
}

/**
 * First id that stores `name`. A row other than `selfId` wins, so a name that
 * another row already has is refused even when this row has it too.
 *
 * @param rows - Stored places, in store order.
 * @param name - Exact name the write would store.
 * @param selfId - Id of the row being written, or null on insert.
 * @returns That id, the row's own id when it is the only match, or null.
 */
function nameOwnerId(
  rows: readonly { id: string; name: string }[],
  name: string,
  selfId: string | null,
): string | null {
  let own: string | null = null;
  for (const row of rows) {
    if (row.name !== name) {
      continue;
    }
    if (selfId !== null && row.id === selfId) {
      own = row.id;
      continue;
    }
    return row.id;
  }
  return own;
}

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
    photos: place.photos.map((photo) => ({ ...photo })),
  };
}

/** The stored reference of a prepared photo, without its bytes. */
function storedPhotoOf(photo: PreparedPhoto): StoredPlacePhoto {
  return {
    sha256: photo.sha256,
    contentType: photo.contentType,
    width: photo.width,
    height: photo.height,
    caption: photo.caption,
  };
}

/**
 * List why the public map hides a stored pin. This defines the completeness rule for
 * `MemoryMapPlaceStore` and supplies `complete` and `problems` on `GET /admin/places`.
 * `SqliteMapPlaceStore` applies the same rule in SQL via `COMPLETE_PLACE_SQL` for its public list.
 * Empty when the pin is complete.
 * A row is complete when name, description, street, house number, postal code,
 * city, and country are non-empty, shop type is SPAR or Others, a NOSTR key is
 * stored (R7), and
 * lastTransactionAt is null or a parseable instant with a four-digit year, which
 * matches SQLite `julianday()` for the canonical ISO instants this service writes.
 * `active` is not part of this rule. The Google Maps link is not part of it either.
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
    lastTransactionAt === null ||
    (/^\d{4}-/u.test(lastTransactionAt) && Number.isFinite(Date.parse(lastTransactionAt)));
  if (!lastInstantOk) {
    problems.push('lastTransactionAt is not a valid instant');
  }
  if (place.nostrPubkey === null) {
    problems.push('nostrPubkey is missing');
  }
  return problems;
}

function isCompletePlace(row: StoredMapPlace): boolean {
  return placeProblems(row).length === 0;
}

function isPublicPlace(row: StoredMapPlace): boolean {
  return isCompletePlace(row) && row.active;
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
    const match = matchesUnstatedPayment(row.techProvider, filter.blockchain, filter.asset);
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
    photos: [],
    nostrPubkey: input.nostrPubkey ?? null,
    lastTransactionAt: null,
    activity: 'none',
    active: true,
    googleMapsUrl: input.googleMapsUrl === undefined ? null : input.googleMapsUrl,
    id,
    createdAt,
  };
}

function pairKey(origin: string, externalId: string): string {
  return `${origin}\n${externalId}`;
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

/** How `replaceById` treats the stored activity token and its refresh deadline. */
export type AdminActivityWrite =
  { kind: 'keep' } | { kind: 'set'; activity: PlaceActivity } | { kind: 'recompute' };

/** One internal-id replace. The id is the address and is not a column this write changes. */
export type ReplaceByIdInput = {
  id: string;
  content: MapPlaceInput;
  createdAt: string;
  lastTransactionAt: string | null;
  activity: AdminActivityWrite;
  /** Always written. There is no keep. */
  active: boolean;
  nowMs: number;
};

/**
 * Result of `replaceById`. `missing`, `conflict` (another row has the pair) and
 * `keyConflict` (R7) write nothing.
 */
export type ReplaceByIdResult =
  | { status: 'updated'; place: StoredMapPlace }
  | { status: 'missing' }
  | { status: 'conflict' }
  | { status: 'keyConflict'; error: MapPlaceWriteError };

/**
 * Store for map pins. The SQLite driver is `sqlite.ts`. Tests use the memory store.
 */
export interface MapPlaceStore {
  insertIfNew(input: MapPlaceInput, revision?: number): MapPlaceWriteResult;
  upsert(input: MapPlaceInput, revision?: number): MapPlaceWriteResult;
  replaceById(input: ReplaceByIdInput): ReplaceByIdResult;
  recordTransaction(
    origin: string,
    externalId: string,
    occurredAt: string,
    nowMs: number,
  ): StoredMapPlace | undefined;
  refreshActivity(nowMs: number): void;
  deleteByKey(origin: string, externalId: string, revision?: number): MapPlaceDeleteResult;
  getById(id: string): StoredMapPlace | undefined;
  deleteById(id: string): boolean;
  replacePhotos(
    origin: string,
    nostrPubkey: string,
    photos: PreparedPhoto[],
    revision?: number,
  ): MapPhotoWriteResult;
  findPublicPhoto(sha256: string): MapPhotoFile | undefined;
  list(limit: number, filter?: MapPlaceListFilter): StoredMapPlace[];
  findPublicByPubkey(pubkey: string): StoredMapPlace | undefined;
  listAll(): StoredMapPlace[];
  filters(blockchain?: string | undefined): {
    countries: string[];
    blockchains: string[];
    assets: string[];
  };
  close(): void;
}

/**
 * Process-local map store. Same insert-once, upsert, replace-by-id, and delete rules as SQLite.
 */
export class MemoryMapPlaceStore implements MapPlaceStore {
  readonly #rows: StoredMapPlace[] = [];
  readonly #paymentDays = new Map<string, Set<string>>();
  readonly #activityUntil = new Map<string, string>();
  /** Every key a pair ever stored. Never shrinks (R7). */
  readonly #reservations = new Map<string, { origin: string; externalId: string }>();
  /** Highest accepted revision per pair. A place delete keeps it (R8). */
  readonly #revisions = new Map<string, number>();
  /** Each distinct photo file once, by the hash of its stripped bytes. */
  readonly #photoFiles = new Map<string, MapPhotoFile>();
  readonly #now: () => Date;

  /**
   * @param now - Clock for `createdAt`. Defaults to `Date`.
   */
  constructor(now?: () => Date) {
    this.#now = now ?? (() => new Date());
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
    return this.#write(input, revision, false);
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
    return this.#write(input, revision, true);
  }

  #write(
    input: MapPlaceInput,
    revision: number | undefined,
    replace: boolean,
  ): MapPlaceWriteResult {
    const pair = pairKey(input.origin, input.externalId);
    const existing = this.#rows.find(
      (row) => row.origin === input.origin && row.externalId === input.externalId,
    );
    const conflict = placeWriteConflict({
      storedRevision: this.#revisions.get(pair),
      revision,
      rowExists: existing !== undefined,
      storedKey: existing?.nostrPubkey ?? null,
      key: input.nostrPubkey,
      reservedFor:
        input.nostrPubkey === undefined ? undefined : this.#reservations.get(input.nostrPubkey),
      origin: input.origin,
      externalId: input.externalId,
    });
    if (conflict !== null) {
      return { ok: false, error: conflict };
    }
    // A repeat insert keeps the stored name, so a foreign name in the payload is not a conflict.
    if (replace || existing === undefined) {
      const selfId = existing === undefined ? null : existing.id;
      const nameConflict = placeNameConflict(nameOwnerId(this.#rows, input.name, selfId), selfId);
      if (nameConflict !== null) {
        return { ok: false, error: nameConflict };
      }
    }
    if (input.nostrPubkey !== undefined && !this.#reservations.has(input.nostrPubkey)) {
      this.#reservations.set(input.nostrPubkey, {
        origin: input.origin,
        externalId: input.externalId,
      });
    }
    if (revision !== undefined) {
      this.#revisions.set(pair, revision);
    }
    if (existing === undefined) {
      const place = toStoredPlace(input, crypto.randomUUID(), this.#now().toISOString());
      this.#rows.push(place);
      return { ok: true, created: true, place: copyStoredPlace(place) };
    }
    if (existing.nostrPubkey === null && input.nostrPubkey !== undefined) {
      existing.nostrPubkey = input.nostrPubkey;
    }
    if (replace) {
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
      if (input.googleMapsUrl !== undefined) {
        existing.googleMapsUrl = input.googleMapsUrl;
      }
    }
    return { ok: true, created: false, place: copyStoredPlace(existing) };
  }

  /**
   * Replace every stored fact of one internal id except the id, a stored key, the photos, the
   * payment days and the pair's revision.
   * A missing id writes nothing. Another row with this origin and caller id writes nothing.
   * A key follows R7 as in a source write, checked against the new pair: a row
   * without a key stores the sent one unless it is reserved for another pair, and
   * a stored key cannot change. The row's key reservation moves to the new pair.
   * Another row with this exact name writes nothing. The row's own name is allowed.
   * Revisions (R8) are neither checked nor stored.
   * `keep` does not change activity, the refresh deadline, or payment days.
   * `set` stores that token, clears the refresh deadline, and leaves payment days.
   * `recompute` leaves payment days and classifies from the written instant.
   * `active` is stored as given. The Google Maps link is written only when the
   * content carries that property.
   *
   * @param input - Id, validated pin, timestamps, activity write, and clock.
   * @returns A copy when updated, otherwise missing, conflict, or `{ status: 'keyConflict', error }`
   * with the R7 text or `Place name belongs to another place`.
   */
  replaceById(input: ReplaceByIdInput): ReplaceByIdResult {
    const existing = this.#rows.find((row) => row.id === input.id);
    if (existing === undefined) {
      return { status: 'missing' };
    }
    const conflict = this.#rows.find(
      (row) =>
        row.id !== existing.id &&
        row.origin === input.content.origin &&
        row.externalId === input.content.externalId,
    );
    if (conflict !== undefined) {
      return { status: 'conflict' };
    }
    const key = input.content.nostrPubkey;
    const keyConflict = placeWriteConflict({
      storedRevision: undefined,
      revision: undefined,
      rowExists: true,
      storedKey: existing.nostrPubkey,
      key,
      reservedFor: key === undefined ? undefined : this.#reservations.get(key),
      origin: input.content.origin,
      externalId: input.content.externalId,
    });
    if (keyConflict !== null) {
      return { status: 'keyConflict', error: keyConflict };
    }
    const nameConflict = placeNameConflict(
      nameOwnerId(this.#rows, input.content.name, existing.id),
      existing.id,
    );
    if (nameConflict !== null) {
      return { status: 'keyConflict', error: nameConflict };
    }
    existing.nostrPubkey = existing.nostrPubkey ?? key ?? null;
    if (existing.nostrPubkey !== null) {
      this.#reservations.set(existing.nostrPubkey, {
        origin: input.content.origin,
        externalId: input.content.externalId,
      });
    }
    existing.origin = input.content.origin;
    existing.externalId = input.content.externalId;
    existing.name = input.content.name;
    existing.description = input.content.description;
    existing.lat = input.content.lat;
    existing.lon = input.content.lon;
    existing.category = input.content.category;
    existing.paymentMethods = input.content.paymentMethods;
    existing.techProvider = input.content.techProvider ?? DEFAULT_TECH_PROVIDER;
    existing.shopType = input.content.shopType;
    existing.street = input.content.street;
    existing.houseNumber = input.content.houseNumber;
    existing.postalCode = input.content.postalCode;
    existing.city = input.content.city;
    existing.country = input.content.country;
    existing.supports = storedSupports(input.content.supports);
    existing.createdAt = input.createdAt;
    existing.lastTransactionAt = input.lastTransactionAt;
    existing.active = input.active;
    if (input.content.googleMapsUrl !== undefined) {
      existing.googleMapsUrl = input.content.googleMapsUrl;
    }
    if (input.activity.kind === 'set') {
      existing.activity = input.activity.activity;
      this.#activityUntil.delete(existing.id);
    } else if (input.activity.kind === 'recompute') {
      const classified = placeActivity(
        input.lastTransactionAt,
        storedPaymentDays(this.#paymentDays.get(existing.id)),
        input.nowMs,
      );
      existing.activity = classified.activity;
      if (classified.until === null) {
        this.#activityUntil.delete(existing.id);
      } else {
        this.#activityUntil.set(existing.id, classified.until);
      }
    }
    return { status: 'updated', place: copyStoredPlace(existing) };
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
   * Remove the pin for this origin and external id. The pair's key reservations
   * and revision stay.
   *
   * @param origin - Pin origin.
   * @param externalId - Caller id.
   * @param revision - Request revision (R8), when sent. Stored also when no row matched.
   * @returns Whether a row was removed, or `Stale revision`.
   */
  deleteByKey(origin: string, externalId: string, revision?: number): MapPlaceDeleteResult {
    const pair = pairKey(origin, externalId);
    const stored = this.#revisions.get(pair);
    if (stored !== undefined && (revision === undefined || revision <= stored)) {
      return { ok: false, error: 'Stale revision' };
    }
    if (revision !== undefined) {
      this.#revisions.set(pair, revision);
    }
    const existing = this.#rows.find(
      (row) => row.origin === origin && row.externalId === externalId,
    );
    if (existing === undefined) {
      return { ok: true, deleted: false };
    }
    this.#paymentDays.delete(existing.id);
    this.#activityUntil.delete(existing.id);
    this.#rows.splice(this.#rows.indexOf(existing), 1);
    this.#dropUnusedPhotos();
    return { ok: true, deleted: true };
  }

  #dropUnusedPhotos(): void {
    const used = new Set(this.#rows.flatMap((row) => row.photos.map((photo) => photo.sha256)));
    for (const sha256 of [...this.#photoFiles.keys()]) {
      if (!used.has(sha256)) {
        this.#photoFiles.delete(sha256);
      }
    }
  }

  /**
   * Replace every photo of the stored place with this key and origin, listed or
   * not. Files no place uses any more are dropped.
   *
   * @param origin - Origin that registered the place.
   * @param nostrPubkey - The place's key.
   * @param photos - Prepared photos in display order.
   * @param revision - Request revision (R8), when sent; it shares the place's counter.
   * @returns The stored photo list, `Place not found` when no place of that origin
   * has the key, or `Stale revision`.
   */
  replacePhotos(
    origin: string,
    nostrPubkey: string,
    photos: PreparedPhoto[],
    revision?: number,
  ): MapPhotoWriteResult {
    const row = this.#rows.find(
      (item) => item.nostrPubkey === nostrPubkey && item.origin === origin,
    );
    if (row === undefined) {
      return { ok: false, error: 'Place not found' };
    }
    const pair = pairKey(row.origin, row.externalId);
    const stored = this.#revisions.get(pair);
    if (stored !== undefined && (revision === undefined || revision <= stored)) {
      return { ok: false, error: 'Stale revision' };
    }
    if (revision !== undefined) {
      this.#revisions.set(pair, revision);
    }
    for (const photo of photos) {
      if (!this.#photoFiles.has(photo.sha256)) {
        this.#photoFiles.set(photo.sha256, {
          contentType: photo.contentType,
          data: photo.data.slice(),
        });
      }
    }
    row.photos = photos.map(storedPhotoOf);
    this.#dropUnusedPhotos();
    return { ok: true, photos: row.photos.map((photo) => ({ ...photo })) };
  }

  /**
   * A photo file that a public place uses.
   *
   * @param sha256 - Hash of the stripped bytes.
   * @returns A copy of the file, or undefined when no public place shows it.
   */
  findPublicPhoto(sha256: string): MapPhotoFile | undefined {
    const file = this.#photoFiles.get(sha256);
    const shown = this.#rows.some(
      (row) => isPublicPlace(row) && row.photos.some((photo) => photo.sha256 === sha256),
    );
    return file === undefined || !shown
      ? undefined
      : { contentType: file.contentType, data: file.data.slice() };
  }

  /**
   * The public pin that carries this key.
   *
   * @param pubkey - 64 lowercase hex characters.
   * @returns A copy of the row, or undefined when no public row has the key.
   */
  findPublicByPubkey(pubkey: string): StoredMapPlace | undefined {
    const row = this.#rows.find((item) => item.nostrPubkey === pubkey && isPublicPlace(item));
    return row === undefined ? undefined : copyStoredPlace(row);
  }

  /**
   * Read one pin by its internal id.
   *
   * @param id - Internal id, compared exactly.
   * @returns A copy of the row, or undefined when the id is missing.
   */
  getById(id: string): StoredMapPlace | undefined {
    const existing = this.#rows.find((row) => row.id === id);
    if (existing === undefined) {
      return undefined;
    }
    return copyStoredPlace(existing);
  }

  /**
   * Remove the pin with this internal id. Revisions (R8) are neither checked nor
   * stored; the pair's key reservations and revision stay.
   *
   * @param id - Internal id, compared exactly.
   * @returns Whether a row was removed. False when the id is missing.
   */
  deleteById(id: string): boolean {
    const existing = this.#rows.find((row) => row.id === id);
    if (existing === undefined) {
      return false;
    }
    this.#paymentDays.delete(existing.id);
    this.#activityUntil.delete(existing.id);
    this.#rows.splice(this.#rows.indexOf(existing), 1);
    this.#dropUnusedPhotos();
    return true;
  }

  /**
   * Newest public pins first, then id descending.
   *
   * @param limit - Maximum rows.
   * @param filter - Optional AND predicates, applied before sort and limit.
   * @returns A copy of the stored pins.
   */
  list(limit: number, filter?: MapPlaceListFilter): StoredMapPlace[] {
    const rows = this.#rows.filter((row) => isPublicPlace(row) && matchesFilter(row, filter));
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
   * @returns Countries of public rows, plus blockchains and assets from every row.
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
      if (isPublicPlace(row)) {
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
    this.#reservations.clear();
    this.#revisions.clear();
    this.#photoFiles.clear();
  }
}
