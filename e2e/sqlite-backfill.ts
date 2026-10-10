import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMapPlaceStore } from '../src/lib/map/sqlite';
import { MAP_PLACE_SCHEMA_SQL } from '../src/lib/map/store';

const dir = mkdtempSync(join(tmpdir(), 'sqlite-backfill-'));
const filename = join(dir, 'map.sqlite');
let seed: Database | undefined;
let store: SqliteMapPlaceStore | undefined;
try {
  seed = new Database(filename);
  const statements = MAP_PLACE_SCHEMA_SQL.split(';')
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
    null,
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
    null,
    null,
  );
  insert.run(
    'spar-migros-row',
    'spar',
    'spar-migros',
    'Pin',
    47.37,
    8.54,
    'groceries',
    null,
    '2026-01-03T00:00:00.000Z',
    'DFX.swiss',
    null,
    'Migros',
  );
  insert.run(
    'spar-ch-1713-row',
    'spar',
    'spar-ch-1713',
    'SPAR 1713',
    47.37,
    8.54,
    'groceries',
    null,
    '2026-01-04T00:00:00.000Z',
    'DFX.swiss',
    null,
    null,
  );
  insert.run(
    'spar-li-9495-row',
    'spar',
    'spar-li-9495',
    'SPAR 9495 Triesen',
    47.37,
    8.54,
    'groceries',
    null,
    '2026-01-05T00:00:00.000Z',
    'DFX.swiss',
    null,
    null,
  );
  insert.run(
    'spar-de-keep-row',
    'spar',
    'spar-de-keep',
    'SPAR 8001',
    47.37,
    8.54,
    'groceries',
    null,
    '2026-01-06T00:00:00.000Z',
    'DFX.swiss',
    'DE',
    null,
  );
  insert.run(
    'gifts-ph-happyland-row',
    '21gifts',
    'gifts-ph-happyland',
    'Happyland Court Barangay 105 Tondo, Manila',
    47.37,
    8.54,
    'groceries',
    null,
    '2026-01-07T00:00:00.000Z',
    '21.gifts',
    null,
    null,
  );
  insert.run(
    'gifts-ph-rose-row',
    '21gifts',
    'gifts-ph-rose',
    'Rose st.Happyland Barangay 105 Tondo,Manila',
    47.37,
    8.54,
    'groceries',
    null,
    '2026-01-08T00:00:00.000Z',
    '21.gifts',
    null,
    null,
  );
  insert.run(
    'gifts-ke-machakos-row',
    '21gifts',
    'gifts-ke-machakos',
    'Machakos Bitcoin Academy',
    47.37,
    8.54,
    'groceries',
    null,
    '2026-01-09T00:00:00.000Z',
    '21.gifts',
    null,
    null,
  );
  insert.run(
    'gifts-ke-makueni-row',
    '21gifts',
    'gifts-ke-makueni',
    'bitcoinmakueni',
    47.37,
    8.54,
    'groceries',
    null,
    '2026-01-10T00:00:00.000Z',
    '21.gifts',
    null,
    null,
  );
  insert.run(
    'gifts-other-row',
    '21gifts',
    'gifts-other',
    'Other shop',
    47.37,
    8.54,
    'groceries',
    null,
    '2026-01-11T00:00:00.000Z',
    '21.gifts',
    null,
    null,
  );
  seed.close();
  seed = undefined;
  store = new SqliteMapPlaceStore(filename);
  const listed = store.list(20);
  const sparNull = listed.find((row) => row.externalId === 'spar-null');
  const dfxNull = listed.find((row) => row.externalId === 'dfx-null');
  const sparMigros = listed.find((row) => row.externalId === 'spar-migros');
  const sparCh1713 = listed.find((row) => row.externalId === 'spar-ch-1713');
  const sparLi9495 = listed.find((row) => row.externalId === 'spar-li-9495');
  const sparDeKeep = listed.find((row) => row.externalId === 'spar-de-keep');
  const giftsPhHappyland = listed.find((row) => row.externalId === 'gifts-ph-happyland');
  const giftsPhRose = listed.find((row) => row.externalId === 'gifts-ph-rose');
  const giftsKeMachakos = listed.find((row) => row.externalId === 'gifts-ke-machakos');
  const giftsKeMakueni = listed.find((row) => row.externalId === 'gifts-ke-makueni');
  const giftsOther = listed.find((row) => row.externalId === 'gifts-other');
  if (
    sparNull !== undefined &&
    dfxNull !== undefined &&
    sparMigros !== undefined &&
    sparCh1713 !== undefined &&
    sparLi9495 !== undefined &&
    sparDeKeep !== undefined &&
    giftsPhHappyland !== undefined &&
    giftsPhRose !== undefined &&
    giftsKeMachakos !== undefined &&
    giftsKeMakueni !== undefined &&
    giftsOther !== undefined &&
    sparNull.shopName === 'SPAR' &&
    sparNull.country === null &&
    dfxNull.shopName === null &&
    dfxNull.country === null &&
    sparMigros.shopName === 'Migros' &&
    sparMigros.country === null &&
    sparCh1713.country === 'CH' &&
    sparCh1713.shopName === 'SPAR' &&
    sparLi9495.country === 'LI' &&
    sparDeKeep.country === 'DE' &&
    giftsPhHappyland.country === 'PH' &&
    giftsPhRose.country === 'PH' &&
    giftsKeMachakos.country === 'KE' &&
    giftsKeMakueni.country === 'KE' &&
    giftsOther.country === null
  ) {
    process.stdout.write('ok\n');
  } else {
    process.stdout.write(
      `${JSON.stringify({
        'spar-null':
          sparNull === undefined
            ? null
            : { shopName: sparNull.shopName, country: sparNull.country },
        'dfx-null':
          dfxNull === undefined ? null : { shopName: dfxNull.shopName, country: dfxNull.country },
        'spar-migros':
          sparMigros === undefined
            ? null
            : { shopName: sparMigros.shopName, country: sparMigros.country },
        'spar-ch-1713':
          sparCh1713 === undefined
            ? null
            : { shopName: sparCh1713.shopName, country: sparCh1713.country },
        'spar-li-9495': sparLi9495 === undefined ? null : sparLi9495.country,
        'spar-de-keep': sparDeKeep === undefined ? null : sparDeKeep.country,
        'gifts-ph-happyland': giftsPhHappyland === undefined ? null : giftsPhHappyland.country,
        'gifts-ph-rose': giftsPhRose === undefined ? null : giftsPhRose.country,
        'gifts-ke-machakos': giftsKeMachakos === undefined ? null : giftsKeMachakos.country,
        'gifts-ke-makueni': giftsKeMakueni === undefined ? null : giftsKeMakueni.country,
        'gifts-other': giftsOther === undefined ? null : giftsOther.country,
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
