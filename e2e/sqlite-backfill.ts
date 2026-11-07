import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import googleMapsSeed from '../src/lib/map/google-maps-seed.json' with { type: 'json' };
import { isNostrPubkey, npubDecode } from '../src/lib/map/nostr-key';
import { preparePhoto, type PreparedPhoto } from '../src/lib/map/photo';
import { simplePng } from '../src/__tests__/map/photo-fixtures';
import { placeActivity } from '../src/lib/map/place';
import type { MapPlaceInput } from '../src/lib/map/place';
import { SqliteMapPlaceStore } from '../src/lib/map/sqlite';
import { MAP_PLACE_SCHEMA_SQL, placeProblems } from '../src/lib/map/store';

/** A valid NIP-01 key derived from a label, so each test row has its own. */
function keyFor(label: string): string {
  for (let round = 0; ; round += 1) {
    const candidate = createHash('sha256')
      .update(`${label}:${String(round)}`)
      .digest('hex');
    if (isNostrPubkey(candidate)) {
      return candidate;
    }
  }
}

const DESCRIPTION =
  'SPAR supermarket in Triesen. Customers can pay with Bitcoin and other crypto assets through OpenCryptoPay at the checkout.';

const COMPLETE: MapPlaceInput = {
  origin: 'dfx',
  externalId: 'dfx-null',
  name: 'SPAR Triesen',
  description: DESCRIPTION,
  lat: 47.37,
  lon: 8.54,
  category: 'groceries',
  paymentMethods: null,
  shopType: 'SPAR',
  street: 'Maschlinastrasse',
  houseNumber: '4',
  postalCode: '9495',
  city: 'Triesen',
  country: 'LI',
  supports: [],
  nostrPubkey: keyFor('dfx-null'),
};

const OLD_MAP_PLACE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS map_place (
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

const OLD_MAP_PLACE_TABLE = `CREATE TABLE IF NOT EXISTS map_place (
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
)`;

function shiftUtcDay(day: string, deltaDays: number): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, date + deltaDays)).toISOString().slice(0, 10);
}

function paymentDaysFor(filename: string, placeId: string): string[] {
  const db = new Database(filename);
  try {
    const rows = db
      .query('SELECT day FROM map_place_payment_day WHERE place_id = ? ORDER BY day')
      .all(placeId) as Array<{ day: string }>;
    return rows.map((row) => row.day);
  } finally {
    db.close();
  }
}

function columnNames(filename: string): string[] {
  const db = new Database(filename);
  try {
    const rows = db.query('PRAGMA table_info(map_place)').all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  } finally {
    db.close();
  }
}

function placeCount(filename: string): number {
  const db = new Database(filename);
  try {
    const row = db.query('SELECT COUNT(*) AS n FROM map_place').get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function activityByExternalId(
  filename: string,
  externalId: string,
): { activity: string; last_transaction_at: string | null } | undefined {
  const db = new Database(filename);
  try {
    const row = db
      .query('SELECT activity, last_transaction_at FROM map_place WHERE external_id = ?')
      .get(externalId) as { activity: string; last_transaction_at: string | null } | null;
    return row === null ? undefined : row;
  } finally {
    db.close();
  }
}

const dir = mkdtempSync(join(tmpdir(), 'sqlite-backfill-'));
const filename = join(dir, 'map.sqlite');
let seed: Database | undefined;
let store: SqliteMapPlaceStore | undefined;
let schemaOk = false;
try {
  seed = new Database(filename);
  const statements = OLD_MAP_PLACE_SCHEMA_SQL.split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  for (const sql of statements) {
    seed.exec(sql);
  }
  const insert = seed.query(
    `INSERT INTO map_place (
       id, origin, external_id, name, lat, lon, category, payment_methods, created_at, tech_provider, country, shop_name
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    'spar-null-row',
    'spar',
    'spar-null',
    'Pin',
    47.37,
    8.54,
    'groceries',
    null,
    '2026-01-01T00:00:00.000Z',
    'DFX.swiss',
    null,
    'SPAR',
  );
  insert.run(
    'dfx-null-row',
    'dfx',
    'dfx-null',
    'Pin',
    47.37,
    8.54,
    'groceries',
    null,
    '2026-01-02T00:00:00.000Z',
    'DFX.swiss',
    'CH',
    null,
  );
  seed.close();
  seed = undefined;
  store = new SqliteMapPlaceStore(filename);
  const columns = columnNames(filename);
  const listed = store.list(20);
  const opened = store.listAll();
  const countries = store.filters().countries;
  const kept = placeCount(filename);
  if (
    columns.includes('description') &&
    columns.includes('shop_type') &&
    columns.includes('shop_name') &&
    columns.includes('active') &&
    kept === 2 &&
    listed.length === 0 &&
    opened.length === 2 &&
    opened.every((row) => row.active === true) &&
    countries.length === 0
  ) {
    const published = store.upsert(COMPLETE);
    const afterPut = store.list(20);
    const afterCountries = store.filters().countries;
    store.upsert({
      ...COMPLETE,
      origin: 'dfx',
      externalId: 'bad-time',
      nostrPubkey: keyFor('bad-time'),
      country: 'AT',
      postalCode: '1010',
      city: 'Wien',
      street: 'Kaerntner Strasse',
      houseNumber: '1',
      name: 'Hidden Clock Shop',
    });
    store.close();
    store = undefined;
    const patch = new Database(filename);
    patch
      .query("UPDATE map_place SET last_transaction_at = 'not-a-date' WHERE external_id = ?")
      .run('bad-time');
    patch.close();
    store = new SqliteMapPlaceStore(filename);
    const afterBad = store.list(20);
    const afterBadCountries = store.filters().countries;
    if (
      published.ok &&
      !published.created &&
      columns.includes('nostr_pubkey') &&
      afterPut.length === 1 &&
      afterPut[0]?.externalId === 'dfx-null' &&
      afterPut[0]?.country === 'LI' &&
      afterPut[0]?.shopType === 'SPAR' &&
      afterPut[0]?.description === DESCRIPTION &&
      afterCountries.includes('LI') &&
      !afterCountries.includes('CH') &&
      afterBad.every((row) => row.externalId !== 'bad-time') &&
      afterBadCountries.includes('LI') &&
      !afterBadCountries.includes('AT')
    ) {
      schemaOk = true;
    } else {
      process.stdout.write(
        `${JSON.stringify({
          published,
          afterPut: afterPut.map((row) => row.externalId),
          afterCountries,
          afterBad: afterBad.map((row) => row.externalId),
          afterBadCountries,
        })}\n`,
      );
      process.exitCode = 1;
    }
  } else {
    process.stdout.write(
      `${JSON.stringify({
        columns,
        kept,
        listed: listed.map((row) => row.externalId),
        opened: opened.map((row) => row.active),
        countries,
      })}\n`,
    );
    process.exitCode = 1;
  }
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : error })}\n`,
  );
  process.exitCode = 1;
} finally {
  try {
    if (seed !== undefined) {
      seed.close();
    }
    if (store !== undefined) {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let listAllOk = false;
if (schemaOk) {
  const listDir = mkdtempSync(join(tmpdir(), 'sqlite-list-all-'));
  const listFile = join(listDir, 'map.sqlite');
  let listStore: SqliteMapPlaceStore | undefined;
  try {
    listStore = new SqliteMapPlaceStore(listFile);
    const complete = listStore.insertIfNew({
      ...COMPLETE,
      externalId: 'complete',
      nostrPubkey: keyFor('complete'),
    });
    const incomplete = listStore.insertIfNew({
      ...COMPLETE,
      externalId: 'incomplete',
      nostrPubkey: keyFor('incomplete'),
      name: '',
    });
    const order = new Database(listFile);
    try {
      order
        .query('UPDATE map_place SET created_at = ? WHERE external_id = ?')
        .run('2000-01-01T00:00:00.000Z', 'complete');
      order
        .query('UPDATE map_place SET created_at = ? WHERE external_id = ?')
        .run('2100-01-01T00:00:00.000Z', 'incomplete');
    } finally {
      order.close();
    }
    const initialAll = listStore.listAll();
    for (let index = 0; index < 501; index += 1) {
      listStore.insertIfNew({
        ...COMPLETE,
        externalId: `bulk-${String(index)}`,
        nostrPubkey: keyFor(`bulk-${String(index)}`),
        name: `Bulk Place ${String(index)}`,
        supports: [{ blockchain: 'Bitcoin', asset: `BTC-${String(index)}` }],
      });
    }
    const all = listStore.listAll();
    const publicRows = listStore.list(1000);
    const bulk = all.filter((row) => row.externalId.startsWith('bulk-'));
    const clock = new Database(listFile);
    try {
      clock
        .query('UPDATE map_place SET last_transaction_at = ? WHERE external_id = ?')
        .run('-000001-01-01T00:00:00.000Z', 'complete');
    } finally {
      clock.close();
    }
    const negativeYear = listStore.listAll().find((row) => row.externalId === 'complete');
    const negativeYearProblems = negativeYear === undefined ? [] : placeProblems(negativeYear);
    const negativeYearHidden = listStore.list(1000).every((row) => row.externalId !== 'complete');
    if (
      complete.ok &&
      complete.created &&
      incomplete.ok &&
      incomplete.created &&
      initialAll.length === 2 &&
      initialAll[0]?.externalId === 'incomplete' &&
      initialAll[1]?.externalId === 'complete' &&
      all.length === 503 &&
      all[0]?.externalId === 'incomplete' &&
      all[all.length - 1]?.externalId === 'complete' &&
      publicRows.length === 502 &&
      publicRows.some((row) => row.externalId === 'complete') &&
      publicRows.every((row) => row.externalId !== 'incomplete') &&
      bulk.length === 501 &&
      bulk.every(
        (row) =>
          row.supports.length === 1 &&
          row.supports[0]?.blockchain === 'Bitcoin' &&
          row.supports[0]?.asset === `BTC-${row.externalId.slice('bulk-'.length)}`,
      ) &&
      negativeYearHidden &&
      negativeYearProblems.length === 1 &&
      negativeYearProblems[0] === 'lastTransactionAt is not a valid instant'
    ) {
      listAllOk = true;
    } else {
      process.stdout.write(
        `${JSON.stringify({
          all: all.length,
          initial: initialAll.map((row) => row.externalId),
          first: all[0]?.externalId,
          last: all[all.length - 1]?.externalId,
          publicRows: publicRows.length,
          publicIncomplete: publicRows.some((row) => row.externalId === 'incomplete'),
          bulk: bulk.length,
          bulkWithSupports: bulk.filter((row) => row.supports.length === 1).length,
          negativeYearHidden,
          negativeYearProblems,
        })}\n`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : error })}\n`,
    );
    process.exitCode = 1;
  } finally {
    try {
      if (listStore !== undefined) {
        listStore.close();
      }
    } finally {
      rmSync(listDir, { recursive: true, force: true });
    }
  }
}

let identityOk = false;
if (schemaOk && listAllOk) {
  const identityDir = mkdtempSync(join(tmpdir(), 'sqlite-identity-'));
  const identityFile = join(identityDir, 'map.sqlite');
  let identityStore: SqliteMapPlaceStore | undefined;
  try {
    identityStore = new SqliteMapPlaceStore(identityFile);
    const keyA = keyFor('identity-a');
    const keyB = keyFor('identity-b');
    const keyC = keyFor('identity-c');
    const base: MapPlaceInput = { ...COMPLETE, externalId: 'identity-1' };
    const keyless: MapPlaceInput = { ...base };
    delete keyless.nostrPubkey;
    const noKey = identityStore.insertIfNew(keyless, 1);
    const hiddenWithoutKey = identityStore
      .list(1000)
      .every((row) => row.externalId !== 'identity-1');
    const staleSame = identityStore.upsert({ ...base, nostrPubkey: keyA }, 1);
    const staleMissing = identityStore.upsert({ ...base, nostrPubkey: keyA });
    const addKey = identityStore.insertIfNew({ ...base, nostrPubkey: keyA }, 2);
    const changed = identityStore.upsert({ ...base, nostrPubkey: keyB }, 3);
    const keptOnPut = identityStore.upsert({ ...keyless, name: 'SPAR Triesen Nord' }, 3);
    const otherPair = identityStore.insertIfNew(
      { ...base, externalId: 'identity-2', nostrPubkey: keyA },
      1,
    );
    const found = identityStore.findPublicByPubkey(keyA);
    const missing = identityStore.findPublicByPubkey(keyC);
    const deleteStale = identityStore.deleteByKey('dfx', 'identity-1', 3);
    const deleted = identityStore.deleteByKey('dfx', 'identity-1', 4);
    const deletedAgain = identityStore.deleteByKey('dfx', 'identity-1', 5);
    const lateOld = identityStore.upsert({ ...base, nostrPubkey: keyA }, 5);
    const reuseOld = identityStore.insertIfNew({ ...base, nostrPubkey: keyA }, 6);
    const afterReuse = identityStore.findPublicByPubkey(keyA);
    identityStore.deleteByKey('dfx', 'identity-1', 7);
    const takenAfterDelete = identityStore.insertIfNew(
      { ...base, externalId: 'identity-3', nostrPubkey: keyA },
      undefined,
    );
    const newKey = identityStore.insertIfNew({ ...base, nostrPubkey: keyC }, 8);
    if (
      noKey.ok &&
      noKey.created &&
      noKey.place.nostrPubkey === null &&
      hiddenWithoutKey &&
      !staleSame.ok &&
      staleSame.error === 'Stale revision' &&
      !staleMissing.ok &&
      staleMissing.error === 'Stale revision' &&
      addKey.ok &&
      !addKey.created &&
      addKey.place.nostrPubkey === keyA &&
      !changed.ok &&
      changed.error === 'nostrPubkey of a place cannot change' &&
      keptOnPut.ok &&
      keptOnPut.place.nostrPubkey === keyA &&
      keptOnPut.place.name === 'SPAR Triesen Nord' &&
      !otherPair.ok &&
      otherPair.error === 'nostrPubkey belongs to another place' &&
      found?.externalId === 'identity-1' &&
      missing === undefined &&
      !deleteStale.ok &&
      deleted.ok &&
      deleted.deleted &&
      deletedAgain.ok &&
      !deletedAgain.deleted &&
      !lateOld.ok &&
      lateOld.error === 'Stale revision' &&
      reuseOld.ok &&
      reuseOld.created &&
      afterReuse?.externalId === 'identity-1' &&
      !takenAfterDelete.ok &&
      takenAfterDelete.error === 'nostrPubkey belongs to another place' &&
      newKey.ok &&
      newKey.place.nostrPubkey === keyC
    ) {
      identityOk = true;
    } else {
      process.stdout.write(
        `${JSON.stringify({
          noKey,
          hiddenWithoutKey,
          staleSame,
          staleMissing,
          addKey: addKey.ok,
          changed,
          keptOnPut: keptOnPut.ok,
          otherPair,
          found: found?.externalId,
          missing,
          deleteStale,
          deleted,
          deletedAgain,
          lateOld,
          reuseOld: reuseOld.ok,
          afterReuse: afterReuse?.externalId,
          takenAfterDelete,
          newKey: newKey.ok,
        })}\n`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : error })}\n`,
    );
    process.exitCode = 1;
  } finally {
    try {
      if (identityStore !== undefined) {
        identityStore.close();
      }
    } finally {
      rmSync(identityDir, { recursive: true, force: true });
    }
  }
}

let photosOk = false;
if (schemaOk && listAllOk && identityOk) {
  const photoDir = mkdtempSync(join(tmpdir(), 'sqlite-photos-'));
  const photoFile = join(photoDir, 'map.sqlite');
  let photoStore: SqliteMapPlaceStore | undefined;
  try {
    photoStore = new SqliteMapPlaceStore(photoFile);
    const prepare = (bytes: Uint8Array, caption?: string): PreparedPhoto => {
      const result = preparePhoto(
        {
          contentType: 'image/png',
          data: Buffer.from(bytes).toString('base64'),
          ...(caption === undefined ? {} : { caption }),
        },
        0,
      );
      if (!result.ok) {
        throw new Error(result.error);
      }
      return result.photo;
    };
    const front = prepare(simplePng(3, 2), 'Front');
    const side = prepare(simplePng(5, 4));
    const keyA = keyFor('photo-a');
    const keyB = keyFor('photo-b');
    const keyC = keyFor('photo-c');
    photoStore.insertIfNew({ ...COMPLETE, externalId: 'photo-a', nostrPubkey: keyA }, 1);
    photoStore.insertIfNew({
      ...COMPLETE,
      externalId: 'photo-b',
      name: 'Photo Two',
      nostrPubkey: keyB,
    });
    photoStore.insertIfNew({ ...COMPLETE, externalId: 'photo-c', name: '', nostrPubkey: keyC });
    const otherOrigin = photoStore.replacePhotos('spar', keyA, [front]);
    const stale = photoStore.replacePhotos('dfx', keyA, [front], 1);
    const stored = photoStore.replacePhotos('dfx', keyA, [front, side], 2);
    photoStore.replacePhotos('dfx', keyB, [front]);
    photoStore.replacePhotos('dfx', keyC, [side]);
    const listed = photoStore.list(10).find((row) => row.externalId === 'photo-a');
    const served = photoStore.findPublicPhoto(front.sha256);
    const sideServed = photoStore.findPublicPhoto(side.sha256) !== undefined;
    photoStore.upsert({ ...COMPLETE, externalId: 'photo-a', nostrPubkey: keyA }, 3);
    const keptOnPut = photoStore.listAll().find((row) => row.externalId === 'photo-a')
      ?.photos.length;
    photoStore.replacePhotos('dfx', keyA, [], 4);
    const sideAfterReplace = photoStore.findPublicPhoto(side.sha256);
    photoStore.deleteByKey('dfx', 'photo-b');
    const frontAfterDelete = photoStore.findPublicPhoto(front.sha256);
    photoStore.deleteByKey('dfx', 'photo-c');
    photoStore.close();
    photoStore = undefined;
    const check = new Database(photoFile);
    let files = -1;
    let refs = -1;
    try {
      files = (check.query('SELECT COUNT(*) AS n FROM map_photo').get() as { n: number }).n;
      refs = (check.query('SELECT COUNT(*) AS n FROM map_place_photo').get() as { n: number }).n;
    } finally {
      check.close();
    }
    if (
      !otherOrigin.ok &&
      otherOrigin.error === 'Place not found' &&
      !stale.ok &&
      stale.error === 'Stale revision' &&
      stored.ok &&
      stored.photos.length === 2 &&
      listed?.photos.map((photo) => photo.sha256).join(',') === `${front.sha256},${side.sha256}` &&
      listed.photos[0]?.caption === 'Front' &&
      listed.photos[1]?.caption === null &&
      listed.photos[1]?.width === 5 &&
      served?.contentType === 'image/png' &&
      Buffer.from(served.data).equals(Buffer.from(front.data)) &&
      sideServed &&
      keptOnPut === 2 &&
      sideAfterReplace === undefined &&
      frontAfterDelete === undefined &&
      files === 0 &&
      refs === 0
    ) {
      photosOk = true;
    } else {
      process.stdout.write(
        `${JSON.stringify({
          otherOrigin,
          stale,
          stored: stored.ok,
          listed: listed?.photos,
          served: served?.contentType,
          sideServed,
          keptOnPut,
          sideAfterReplace: sideAfterReplace !== undefined,
          frontAfterDelete: frontAfterDelete !== undefined,
          files,
          refs,
        })}\n`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : error })}\n`,
    );
    process.exitCode = 1;
  } finally {
    try {
      if (photoStore !== undefined) {
        photoStore.close();
      }
    } finally {
      rmSync(photoDir, { recursive: true, force: true });
    }
  }
}

let adminByIdOk = false;
if (schemaOk && listAllOk && identityOk && photosOk) {
  const adminDir = mkdtempSync(join(tmpdir(), 'sqlite-admin-by-id-'));
  const adminFile = join(adminDir, 'map.sqlite');
  let adminStore: SqliteMapPlaceStore | undefined;
  try {
    adminStore = new SqliteMapPlaceStore(adminFile);
    const keyA = keyFor('admin-a');
    const keyB = keyFor('admin-b');
    const keyC = keyFor('admin-c');
    const replace = (id: string, content: MapPlaceInput) =>
      (adminStore as SqliteMapPlaceStore).replaceById({
        id,
        content,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastTransactionAt: null,
        activity: { kind: 'keep' },
        nowMs: Date.now(),
        active: true,
      });
    const keyless: MapPlaceInput = { ...COMPLETE, externalId: 'admin-1' };
    delete keyless.nostrPubkey;
    const placed = adminStore.insertIfNew(
      { ...COMPLETE, externalId: 'admin-0', nostrPubkey: keyA },
      5,
    );
    const bare = adminStore.insertIfNew({ ...keyless, name: 'Bare Shop' });
    adminStore.insertIfNew({
      ...COMPLETE,
      externalId: 'admin-2',
      name: 'Admin Two',
      nostrPubkey: keyB,
    });
    if (!placed.ok || !bare.ok) {
      throw new Error('admin seed failed');
    }
    const moved = replace(placed.place.id, { ...keyless, origin: 'fremd', externalId: 'moved' });
    const oldPairKey = adminStore.insertIfNew(
      { ...COMPLETE, externalId: 'admin-0', nostrPubkey: keyA },
      6,
    );
    const oldPairRevision = adminStore.insertIfNew(
      { ...COMPLETE, externalId: 'admin-0', nostrPubkey: keyC },
      5,
    );
    const newPairSource = adminStore.upsert({
      ...COMPLETE,
      origin: 'fremd',
      externalId: 'moved',
      nostrPubkey: keyA,
    });
    const reserved = replace(bare.place.id, { ...keyless, nostrPubkey: keyB });
    const taken = replace(bare.place.id, { ...keyless, externalId: 'admin-2' });
    const added = replace(bare.place.id, {
      ...keyless,
      name: bare.place.name,
      nostrPubkey: keyC,
    });
    const changed = replace(bare.place.id, { ...keyless, nostrPubkey: keyB });
    const photo = preparePhoto(
      { contentType: 'image/png', data: Buffer.from(simplePng(3, 2)).toString('base64') },
      0,
    );
    if (!photo.ok) {
      throw new Error(photo.error);
    }
    adminStore.replacePhotos('fremd', keyA, [photo.photo]);
    const servedBefore = adminStore.findPublicPhoto(photo.photo.sha256) !== undefined;
    const deleted = adminStore.deleteById(placed.place.id);
    const deletedAgain = adminStore.deleteById(placed.place.id);
    const servedAfter = adminStore.findPublicPhoto(photo.photo.sha256) !== undefined;
    const keyStillReserved = adminStore.insertIfNew({
      ...COMPLETE,
      externalId: 'admin-9',
      nostrPubkey: keyA,
    });
    if (
      moved.status === 'updated' &&
      moved.place.nostrPubkey === keyA &&
      moved.place.origin === 'fremd' &&
      !oldPairKey.ok &&
      oldPairKey.error === 'nostrPubkey belongs to another place' &&
      !oldPairRevision.ok &&
      oldPairRevision.error === 'Stale revision' &&
      newPairSource.ok &&
      newPairSource.place.id === placed.place.id &&
      reserved.status === 'keyConflict' &&
      reserved.error === 'nostrPubkey belongs to another place' &&
      taken.status === 'conflict' &&
      added.status === 'updated' &&
      added.place.nostrPubkey === keyC &&
      changed.status === 'keyConflict' &&
      changed.error === 'nostrPubkey of a place cannot change' &&
      servedBefore &&
      deleted &&
      !deletedAgain &&
      !servedAfter &&
      !keyStillReserved.ok &&
      adminStore.getById(placed.place.id) === undefined &&
      adminStore.getById(bare.place.id)?.nostrPubkey === keyC
    ) {
      adminByIdOk = true;
    } else {
      process.stdout.write(
        `${JSON.stringify({
          moved,
          oldPairKey,
          oldPairRevision,
          newPairSource: newPairSource.ok,
          reserved,
          taken,
          added: added.status,
          changed,
          servedBefore,
          deleted,
          deletedAgain,
          servedAfter,
          keyStillReserved,
        })}\n`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : error })}\n`,
    );
    process.exitCode = 1;
  } finally {
    try {
      if (adminStore !== undefined) {
        adminStore.close();
      }
    } finally {
      rmSync(adminDir, { recursive: true, force: true });
    }
  }
}

let googleMapsOk = false;
if (schemaOk && listAllOk && identityOk && photosOk && adminByIdOk) {
  let mapsDir: string | undefined;
  let mapsSeed: Database | undefined;
  let mapsStore: SqliteMapPlaceStore | undefined;
  try {
    const first = googleMapsSeed[0];
    const second = googleMapsSeed[1];
    if (first === undefined || second === undefined) {
      throw new Error('google maps seed is missing a row');
    }
    const firstPubkey = npubDecode(first.npub);
    const secondPubkey = npubDecode(second.npub);
    if (firstPubkey === null || secondPubkey === null) {
      throw new Error('google maps seed npub did not decode');
    }
    mapsDir = mkdtempSync(join(tmpdir(), 'sqlite-google-maps-'));
    const mapsFile = join(mapsDir, 'map.sqlite');
    const schemaWithoutLink = MAP_PLACE_SCHEMA_SQL.split('\n')
      .filter((line) => line !== '  google_maps_url TEXT,')
      .join('\n');
    mapsSeed = new Database(mapsFile);
    for (const part of schemaWithoutLink.split(';')) {
      const statement = part.trim();
      if (statement !== '') {
        mapsSeed.exec(statement);
      }
    }
    mapsSeed
      .query(
        `INSERT INTO map_place (
           id, origin, external_id, name, lat, lon, category, created_at, tech_provider, activity,
           active, nostr_pubkey
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'maps-1',
        'spar',
        'maps-1',
        'SPAR Maps One',
        47.37,
        8.54,
        'groceries',
        '2026-01-01T00:00:00.000Z',
        'DFX.swiss',
        'none',
        1,
        firstPubkey,
      );
    mapsSeed.close();
    mapsSeed = undefined;
    const readLink = (pubkey: string): string | null | undefined => {
      const opened = new SqliteMapPlaceStore(mapsFile);
      try {
        const row = opened.listAll().find((place) => place.nostrPubkey === pubkey);
        if (row === undefined) {
          return undefined;
        }
        return row.googleMapsUrl;
      } finally {
        opened.close();
      }
    };
    const seeded = readLink(firstPubkey);
    const reopened = readLink(firstPubkey);
    const otherLink = 'https://maps.app.goo.gl/abc';
    mapsStore = new SqliteMapPlaceStore(mapsFile);
    const replaced = mapsStore.upsert({
      ...COMPLETE,
      origin: 'spar',
      externalId: 'maps-1',
      name: 'SPAR Maps One',
      nostrPubkey: firstPubkey,
      googleMapsUrl: otherLink,
    });
    mapsStore.close();
    mapsStore = undefined;
    const afterReplace = readLink(firstPubkey);
    const mapsOne: MapPlaceInput = {
      ...COMPLETE,
      origin: 'spar',
      externalId: 'maps-1',
      name: 'SPAR Maps One',
      nostrPubkey: firstPubkey,
    };
    mapsStore = new SqliteMapPlaceStore(mapsFile);
    const kept = mapsStore.upsert(mapsOne);
    const repeated = mapsStore.insertIfNew({
      ...mapsOne,
      googleMapsUrl: 'https://maps.app.goo.gl/repeat',
    });
    mapsStore.close();
    mapsStore = undefined;
    const afterKeep = readLink(firstPubkey);
    mapsStore = new SqliteMapPlaceStore(mapsFile);
    const cleared = mapsStore.upsert({
      ...COMPLETE,
      origin: 'spar',
      externalId: 'maps-1',
      name: 'SPAR Maps One',
      nostrPubkey: firstPubkey,
      googleMapsUrl: null,
    });
    const inserted = mapsStore.insertIfNew({
      ...COMPLETE,
      origin: 'spar',
      externalId: 'maps-2',
      name: 'SPAR Maps Two',
      nostrPubkey: secondPubkey,
    });
    mapsStore.close();
    mapsStore = undefined;
    const clearedLink = readLink(firstPubkey);
    const insertedLink = readLink(secondPubkey);
    const adminLink = 'https://maps.google.com/maps/place/admin';
    mapsStore = new SqliteMapPlaceStore(mapsFile);
    const replaceMaps = (content: MapPlaceInput) =>
      (mapsStore as SqliteMapPlaceStore).replaceById({
        id: 'maps-1',
        content,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastTransactionAt: null,
        activity: { kind: 'keep' },
        nowMs: Date.now(),
        active: true,
      });
    const adminSet = replaceMaps({ ...mapsOne, googleMapsUrl: adminLink });
    const adminKept = replaceMaps(mapsOne);
    mapsStore.close();
    mapsStore = undefined;
    const adminStored = readLink(firstPubkey);
    if (
      seeded === first.googleMapsUrl &&
      reopened === first.googleMapsUrl &&
      replaced.ok &&
      !replaced.created &&
      replaced.place.googleMapsUrl === otherLink &&
      afterReplace === otherLink &&
      kept.ok &&
      !kept.created &&
      kept.place.googleMapsUrl === otherLink &&
      repeated.ok &&
      !repeated.created &&
      repeated.place.googleMapsUrl === otherLink &&
      afterKeep === otherLink &&
      cleared.ok &&
      cleared.place.googleMapsUrl === null &&
      clearedLink === null &&
      inserted.ok &&
      inserted.created &&
      inserted.place.googleMapsUrl === null &&
      insertedLink === null &&
      adminSet.status === 'updated' &&
      adminSet.place.googleMapsUrl === adminLink &&
      adminKept.status === 'updated' &&
      adminKept.place.googleMapsUrl === adminLink &&
      adminStored === adminLink
    ) {
      googleMapsOk = true;
    } else {
      process.stdout.write(
        `${JSON.stringify({
          replaced,
          kept,
          repeated,
          cleared,
          inserted,
          adminSet,
          adminKept,
          observed: {
            seeded,
            reopened,
            afterReplace,
            afterKeep,
            clearedLink,
            insertedLink,
            adminStored,
          },
        })}\n`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : error })}\n`,
    );
    process.exitCode = 1;
  } finally {
    try {
      if (mapsSeed !== undefined) {
        mapsSeed.close();
      }
      if (mapsStore !== undefined) {
        mapsStore.close();
      }
    } finally {
      if (mapsDir !== undefined) {
        rmSync(mapsDir, { recursive: true, force: true });
      }
    }
  }
}

if (schemaOk && listAllOk && identityOk && photosOk && adminByIdOk && googleMapsOk) {
  const activityDir = mkdtempSync(join(tmpdir(), 'sqlite-activity-backfill-'));
  const activityFile = join(activityDir, 'map.sqlite');
  let activitySeed: Database | undefined;
  let activityStore: SqliteMapPlaceStore | undefined;
  try {
    const nowMs = Date.now();
    const oldIso = new Date(nowMs - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recentMs = nowMs - 60 * 60 * 1000;
    const recentIso = new Date(recentMs).toISOString();
    activitySeed = new Database(activityFile);
    activitySeed.exec(OLD_MAP_PLACE_TABLE);
    const insert = activitySeed.query(
      `INSERT INTO map_place (
         id, origin, external_id, name, lat, lon, category, payment_methods, created_at, tech_provider, country, shop_name, last_transaction_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      'act-null-row',
      'dfx',
      'act-null',
      'Pin',
      47.37,
      8.54,
      'groceries',
      null,
      '2026-01-01T00:00:00.000Z',
      'DFX.swiss',
      null,
      null,
      null,
    );
    insert.run(
      'act-old-row',
      'dfx',
      'act-old',
      'Pin',
      47.37,
      8.54,
      'groceries',
      null,
      '2026-01-02T00:00:00.000Z',
      'DFX.swiss',
      null,
      null,
      oldIso,
    );
    insert.run(
      'act-recent-row',
      'dfx',
      'act-recent',
      'Pin',
      47.37,
      8.54,
      'groceries',
      null,
      '2026-01-03T00:00:00.000Z',
      'DFX.swiss',
      null,
      null,
      recentIso,
    );
    activitySeed.close();
    activitySeed = undefined;
    activityStore = new SqliteMapPlaceStore(activityFile);
    activityStore.close();
    activityStore = undefined;
    const noneRow = activityByExternalId(activityFile, 'act-null');
    const oldRow = activityByExternalId(activityFile, 'act-old');
    const recentRow = activityByExternalId(activityFile, 'act-recent');
    const noneDays = paymentDaysFor(activityFile, 'act-null-row');
    const oldDays = paymentDaysFor(activityFile, 'act-old-row');
    const recentDays = paymentDaysFor(activityFile, 'act-recent-row');
    activityStore = new SqliteMapPlaceStore(activityFile);
    const recentDay = new Date(recentMs).toISOString().slice(0, 10);
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const windowStart = shiftUtcDay(today, -6);
    const extraDays: string[] = [];
    for (let delta = 1; extraDays.length < 4; delta += 1) {
      const day = shiftUtcDay(recentDay, -delta);
      if (day < windowStart) {
        break;
      }
      extraDays.push(day);
    }
    let dailyPlace = activityStore.recordTransaction('dfx', 'act-recent', 'not-a-date', nowMs);
    let lastAfterExtra = dailyPlace?.lastTransactionAt;
    for (const day of extraDays) {
      dailyPlace = activityStore.recordTransaction(
        'dfx',
        'act-recent',
        `${day}T12:00:00.000Z`,
        nowMs,
      );
    }
    lastAfterExtra = dailyPlace?.lastTransactionAt;
    const countedDays = [recentDay, ...extraDays];
    const classified = placeActivity(recentIso, countedDays, nowMs);
    const untilMs = classified.until === null ? Number.NaN : Date.parse(classified.until);
    if (dailyPlace !== undefined && Number.isFinite(untilMs)) {
      activityStore.refreshActivity(untilMs - 1);
    }
    const beforePivot = activityStore.recordTransaction('dfx', 'act-recent', 'not-a-date', nowMs);
    if (dailyPlace !== undefined && Number.isFinite(untilMs)) {
      activityStore.refreshActivity(untilMs);
    }
    const afterPivot = activityStore.recordTransaction('dfx', 'act-recent', 'not-a-date', nowMs);
    activityStore.close();
    activityStore = undefined;
    const staleDays = new Database(activityFile);
    try {
      staleDays
        .query('INSERT INTO map_place_payment_day (place_id, day) VALUES (?, ?)')
        .run('act-recent-row', '1999-01-01');
    } finally {
      staleDays.close();
    }
    activityStore = new SqliteMapPlaceStore(activityFile);
    activityStore.recordTransaction('dfx', 'act-recent', 'not-a-date', nowMs);
    const daysAfterUnparseable = paymentDaysFor(activityFile, 'act-recent-row');
    activityStore.recordTransaction('dfx', 'act-recent', `${recentDay}T12:00:00.000Z`, nowMs);
    const daysAfterParseable = paymentDaysFor(activityFile, 'act-recent-row');
    if (
      noneRow !== undefined &&
      oldRow !== undefined &&
      recentRow !== undefined &&
      noneRow.activity === 'none' &&
      oldRow.activity === 'olderThan30Days' &&
      recentRow.activity === 'within7Days' &&
      noneDays.length === 0 &&
      oldDays.length === 0 &&
      recentDays.length === 1 &&
      extraDays.length === 4 &&
      classified.activity === 'daily' &&
      dailyPlace?.activity === 'daily' &&
      lastAfterExtra === recentIso &&
      beforePivot?.activity === 'daily' &&
      afterPivot?.activity === 'within7Days' &&
      afterPivot?.lastTransactionAt === recentIso &&
      daysAfterUnparseable.includes('1999-01-01') &&
      !daysAfterParseable.includes('1999-01-01') &&
      daysAfterParseable.includes(recentDay)
    ) {
      process.stdout.write('ok\n');
    } else {
      process.stdout.write(
        `${JSON.stringify({
          none: noneRow,
          old: oldRow,
          recent: recentRow,
          noneDays,
          oldDays,
          recentDays,
          extraDays,
          daily: dailyPlace === undefined ? null : dailyPlace.activity,
          lastAfterExtra,
          beforePivot: beforePivot === undefined ? null : beforePivot.activity,
          afterPivot: afterPivot === undefined ? null : afterPivot.activity,
          daysAfterUnparseable,
          daysAfterParseable,
        })}\n`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : error })}\n`,
    );
    process.exitCode = 1;
  } finally {
    try {
      if (activitySeed !== undefined) {
        activitySeed.close();
      }
      if (activityStore !== undefined) {
        activityStore.close();
      }
    } finally {
      rmSync(activityDir, { recursive: true, force: true });
    }
  }
}
