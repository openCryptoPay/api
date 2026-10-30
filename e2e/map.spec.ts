import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { publicPlaceSupports } from '../src/lib/map/filter-catalog';
import { isNostrPubkey, npubEncode } from '../src/lib/map/nostr-key';
import {
  base64,
  bytesOf,
  exifTiff,
  jpeg,
  jpegSegment,
  scan,
  simpleJpeg,
  simplePng,
  simpleWebp,
  sof,
  vp8,
  vp8l,
  vp8x,
  webp,
  webpChunk,
} from '../src/__tests__/map/photo-fixtures';

/** A valid NIP-01 key derived from a label, so each test shop has its own. */
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

const OTHER_DESCRIPTION =
  'Neighbourhood grocery in Zürich. Customers can pay with Bitcoin and other crypto assets through OpenCryptoPay at the checkout.';

function completePlace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    origin: 'dfx',
    externalId: 'e2e-store',
    name: 'SPAR Triesen',
    description: DESCRIPTION,
    lat: 47.37,
    lon: 8.54,
    category: 'groceries',
    paymentMethods: 'lightning',
    shopType: 'SPAR',
    street: 'Maschlinastrasse',
    houseNumber: '4',
    postalCode: '9495',
    city: 'Triesen',
    country: 'LI',
    ...overrides,
    nostrPubkey:
      overrides['nostrPubkey'] ??
      keyFor(
        `${String(overrides['origin'] ?? 'dfx')}/${String(overrides['externalId'] ?? 'e2e-store')}`,
      ),
  };
}

/** A complete pin without a key, as a source sends it before step 3. */
function keylessPlace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const place = completePlace(overrides);
  delete place['nostrPubkey'];
  return place;
}

const ingest = { Authorization: 'Bearer e2e-ingest' };

const body = completePlace();

test('Function: welcomeRoutes — GET / is a welcome page', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type'] ?? '').toContain('text/html');
  const html = await res.text();
  expect(html).toContain('<h1>Welcome</h1>');
  expect(html).toContain('href="/map/places"');
  expect(html).toContain('href="/map/filters"');
  expect(html).toContain('href="/healthz"');
  expect(html).toContain('https://opencryptopay.io');
});

test('Function: healthRoutes — GET /healthz is public', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('Function: mapRoutes — GET /map/places is public', async ({ request }) => {
  const res = await request.get('/map/places');
  expect(res.status()).toBe(200);
  const json = (await res.json()) as { places: unknown[] };
  expect(Array.isArray(json.places)).toBe(true);
});

test('Function: normalizePlaceOrigin — GET /map/places?origin=spar filters the list', async ({
  request,
}) => {
  const sparPin = completePlace({
    origin: 'spar',
    externalId: 'e2e-origin-spar',
    name: 'Origin SPAR Pin',
  });
  const otherPin = completePlace({
    origin: 'dfx',
    externalId: 'e2e-origin-other',
    name: 'Origin Other Pin',
  });
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: sparPin,
      })
    ).status(),
  ).toBe(201);
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: otherPin,
      })
    ).status(),
  ).toBe(201);

  const filtered = await request.get('/map/places?origin=spar');
  expect(filtered.status()).toBe(200);
  const json = (await filtered.json()) as { places: Array<{ origin: string; name: string }> };
  expect(json.places.some((row) => row.name === 'Origin SPAR Pin')).toBe(true);
  expect(json.places.some((row) => row.name === 'Origin Other Pin')).toBe(false);
  expect(json.places.every((row) => row.origin === 'spar')).toBe(true);

  const bad = await request.get('/map/places?origin=SPAR');
  expect(bad.status()).toBe(400);
  expect(await bad.json()).toEqual({ error: 'Place origin is invalid' });
});

test('Function: createApp — POST /map/places without a bearer is 401', async ({ request }) => {
  const res = await request.post('/map/places', { data: body });
  expect(res.status()).toBe(401);
});

test('Function: isGoogleMapsUrl — an invalid link is 400 and a valid link is listed', async ({
  request,
}) => {
  const invalid = await request.post('/map/places', {
    headers: ingest,
    data: completePlace({
      externalId: 'e2e-google-maps',
      name: 'SPAR Maps Link',
      googleMapsUrl: 'http://www.google.com/maps',
    }),
  });
  expect(invalid.status()).toBe(400);
  expect(await invalid.json()).toEqual({ error: 'Place Google Maps link is invalid' });
  const created = await request.post('/map/places', {
    headers: ingest,
    data: completePlace({
      externalId: 'e2e-google-maps',
      name: 'SPAR Maps Link',
      googleMapsUrl: 'https://maps.app.goo.gl/abc',
    }),
  });
  expect(created.status()).toBe(201);
  const listed = (await (await request.get('/map/places')).json()) as {
    places: Array<{ name: string; googleMapsUrl: string | null }>;
  };
  const row = listed.places.find((place) => place.name === 'SPAR Maps Link');
  expect(row?.googleMapsUrl).toBe('https://maps.app.goo.gl/abc');
});

test('Function: normalizeMapPlace — POST /map/places creates one pin', async ({ request }) => {
  const created = await request.post('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: body,
  });
  expect(created.status()).toBe(201);
  const again = await request.post('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { ...body, name: 'Other' },
  });
  expect(again.status()).toBe(200);
});

test('Function: toPublicMapPlace — the list hides the caller id', async ({ request }) => {
  const created = await request.post('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: completePlace({ externalId: 'e2e-public', name: 'Public List Pin' }),
  });
  expect(created.ok()).toBe(true);
  const res = await request.get('/map/places');
  const json = (await res.json()) as { places: Array<Record<string, unknown>> };
  expect(json.places.some((row) => row['externalId'] !== undefined)).toBe(false);
  expect(
    json.places.every(
      (row) =>
        typeof row['description'] === 'string' &&
        (row['shopType'] === 'SPAR' || row['shopType'] === 'Others') &&
        (row['shopName'] === 'SPAR' || row['shopName'] === null) &&
        typeof row['street'] === 'string' &&
        typeof row['houseNumber'] === 'string' &&
        typeof row['postalCode'] === 'string' &&
        typeof row['city'] === 'string' &&
        typeof row['country'] === 'string',
    ),
  ).toBe(true);
  const createdPin = json.places.find((row) => row['id'] !== undefined);
  expect(createdPin).toBeDefined();
});

test('Function: SqliteMapPlaceStore — the created pin is listed', async ({ request }) => {
  const created = await request.post('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: completePlace({ externalId: 'e2e-listed', name: 'Listed SPAR' }),
  });
  expect(created.ok()).toBe(true);
  const res = await request.get('/map/places');
  const json = (await res.json()) as { places: Array<{ name: string }> };
  expect(json.places.some((row) => row.name === 'Listed SPAR')).toBe(true);
});

test('Function: mapSubmissionBody — default boot does not require a map token', async ({
  request,
}) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: MemoryMapPlaceStore — default boot does not require a map token', async ({
  request,
}) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: pushMapPlace — default boot does not require a map token', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: normalizeMapPlaceFilter — filters one row', async ({ request }) => {
  const sparPin = completePlace({
    origin: 'dfx',
    externalId: 'e2e-filter-spar-ch',
    name: 'Filter SPAR CH',
    country: 'CH',
    postalCode: '8001',
    city: 'Zürich',
    street: 'Bahnhofstrasse',
    houseNumber: '12',
    shopType: 'SPAR',
    supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
  });
  const otherPin = completePlace({
    origin: 'dfx',
    externalId: 'e2e-filter-other',
    name: 'Filter Other Pin',
    description: OTHER_DESCRIPTION,
    country: 'DE',
    postalCode: '10115',
    city: 'Berlin',
    street: 'Other Street',
    houseNumber: '9',
    shopType: 'Others',
    supports: [{ blockchain: 'Bitcoin', asset: 'BTC' }],
  });
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: sparPin,
      })
    ).status(),
  ).toBe(201);
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: otherPin,
      })
    ).status(),
  ).toBe(201);

  const filtered = await request.get(
    '/map/places?shopType=SPAR&country=CH&blockchain=Ethereum&asset=ZCHF',
  );
  expect(filtered.status()).toBe(200);
  const listed = (await filtered.json()) as { places: Array<{ name: string }> };
  expect(listed.places.some((row) => row.name === 'Filter SPAR CH')).toBe(true);
  expect(listed.places.some((row) => row.name === 'Filter Other Pin')).toBe(false);

  const alias = await request.get('/map/places?shopName=others');
  expect(alias.status()).toBe(200);
  const aliasJson = (await alias.json()) as { places: Array<{ name: string }> };
  expect(aliasJson.places.some((row) => row.name === 'Filter Other Pin')).toBe(true);

  const filters = await request.get('/map/filters');
  expect(filters.status()).toBe(200);
  const filterJson = (await filters.json()) as {
    shopTypes: string[];
    shopNames: string[];
    countries: string[];
    blockchains: string[];
    assets: string[];
  };
  expect(filterJson.shopTypes).toEqual(['SPAR', 'Others']);
  expect(filterJson.shopNames).toEqual(['SPAR', 'others']);
  expect(filterJson.countries).toContain('CH');
  expect(filterJson.blockchains).toContain('Ethereum');
  expect(filterJson.assets).toContain('ZCHF');
});

test('Function: SqliteMapPlaceStore — a pair is one support row', async ({ request }) => {
  const pin = completePlace({
    externalId: 'e2e-split-pair',
    name: 'Split Pair Pin',
    supports: [
      { blockchain: 'Polygon', asset: 'ZCHF' },
      { blockchain: 'Ethereum', asset: 'ETH' },
    ],
  });
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: pin,
      })
    ).status(),
  ).toBe(201);

  const names = async (query: string): Promise<string[]> => {
    const response = await request.get(`/map/places?${query}`);
    expect(response.status()).toBe(200);
    const json = (await response.json()) as { places: Array<{ name: string }> };
    return json.places.map((row) => row.name);
  };

  expect(await names('blockchain=Ethereum&asset=ZCHF')).toContain('Split Pair Pin');
  expect(await names('blockchain=Ethereum&asset=ETH')).toContain('Split Pair Pin');
  expect(await names('blockchain=Polygon&asset=ZCHF')).toContain('Split Pair Pin');
});

test('Function: normalizeMapPlaceKey — PUT updates a pin and DELETE removes it', async ({
  request,
}) => {
  const pin = completePlace({
    externalId: 'e2e-provider',
    name: 'Omitted Label Cafe',
    category: 'cafe',
  });
  const created = await request.post('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: pin,
  });
  expect(created.status()).toBe(201);
  const afterCreate = (await (await request.get('/map/places')).json()) as {
    places: Array<{ name: string; techProvider: string }>;
  };
  expect(
    afterCreate.places.some(
      (row) => row.name === 'Omitted Label Cafe' && row.techProvider === 'DFX.swiss',
    ),
  ).toBe(true);

  const renamed = await request.put('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { ...pin, name: 'Updated Label Cafe', techProvider: '21.gifts' },
  });
  expect(renamed.status()).toBe(200);

  const resetProvider = await request.put('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { ...pin, name: 'Updated Label Cafe' },
  });
  expect(resetProvider.status()).toBe(200);

  const afterPut = (await (await request.get('/map/places')).json()) as {
    places: Array<{ name: string; techProvider: string }>;
  };
  expect(
    afterPut.places.some(
      (row) => row.name === 'Updated Label Cafe' && row.techProvider === 'DFX.swiss',
    ),
  ).toBe(true);

  const deleted = await request.delete('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { origin: 'dfx', externalId: 'e2e-provider' },
  });
  expect(deleted.status()).toBe(200);
  expect(await deleted.json()).toEqual({ deleted: true });

  const afterDelete = (await (await request.get('/map/places')).json()) as {
    places: Array<{ name: string }>;
  };
  expect(afterDelete.places.some((row) => row.name === 'Updated Label Cafe')).toBe(false);

  const again = await request.delete('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { origin: 'dfx', externalId: 'e2e-provider' },
  });
  expect(again.status()).toBe(200);
  expect(await again.json()).toEqual({ deleted: false });
});

test('Function: SqliteMapPlaceStore — PUT replaces every field of an existing pin', async ({
  request,
}) => {
  const pin = completePlace({
    externalId: 'e2e-keep-country',
    name: 'Keep Country Pin',
    category: 'cafe',
    country: 'CH',
    street: 'Bahnhofstrasse',
    houseNumber: '12',
    postalCode: '8001',
    city: 'Zürich',
    shopType: 'SPAR',
    supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
  });
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: pin,
      })
    ).status(),
  ).toBe(201);

  const createdList = (await (await request.get('/map/places')).json()) as {
    places: Array<{
      name: string;
      country: string;
      street: string;
      houseNumber: string;
      postalCode: string;
      city: string;
      shopType: string;
      shopName: string | null;
      supports: Array<{ blockchain: string; asset: string }>;
    }>;
  };
  const created = createdList.places.find((row) => row.name === 'Keep Country Pin');
  expect(created?.country).toBe('CH');
  expect(created?.street).toBe('Bahnhofstrasse');
  expect(created?.houseNumber).toBe('12');
  expect(created?.postalCode).toBe('8001');
  expect(created?.city).toBe('Zürich');
  expect(created?.shopType).toBe('SPAR');
  expect(created?.shopName).toBe('SPAR');

  const replaced = await request.put('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: completePlace({
      externalId: 'e2e-keep-country',
      name: 'Keep Country Renamed',
      description: OTHER_DESCRIPTION,
      category: 'cafe',
      country: 'DE',
      street: 'Other Street',
      houseNumber: '99',
      postalCode: '10115',
      city: 'Berlin',
      shopType: 'Others',
      supports: [],
    }),
  });
  expect(replaced.status()).toBe(200);

  const replacedList = (await (await request.get('/map/places')).json()) as {
    places: Array<{
      name: string;
      country: string;
      street: string;
      shopType: string;
      shopName: string | null;
      supports: Array<{ blockchain: string; asset: string }>;
      techProvider: string;
    }>;
  };
  const updated = replacedList.places.find((row) => row.name === 'Keep Country Renamed');
  expect(updated?.country).toBe('DE');
  expect(updated?.street).toBe('Other Street');
  expect(updated?.shopType).toBe('Others');
  expect(updated?.shopName).toBeNull();
  expect(updated?.supports).toEqual(publicPlaceSupports('DFX.swiss'));
  expect(updated?.techProvider).toBe('DFX.swiss');

  const omitted = await request.put('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: {
      origin: 'dfx',
      externalId: 'e2e-keep-country',
      name: 'Keep Country Renamed',
      lat: 47.37,
      lon: 8.54,
      category: 'cafe',
    },
  });
  expect(omitted.status()).toBe(400);
  expect(await omitted.json()).toEqual({ error: 'Place country is invalid' });

  const deleted = await request.delete('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { origin: 'dfx', externalId: 'e2e-keep-country' },
  });
  expect(deleted.status()).toBe(200);
  expect(await deleted.json()).toEqual({ deleted: true });
});

test('Function: SqliteMapPlaceStore — a rejected PUT leaves the stored pin unchanged', async ({
  request,
}) => {
  const pin = completePlace({
    externalId: 'e2e-keep-address',
    name: 'Keep Address Pin',
    category: 'cafe',
    street: 'Bahnhofstrasse',
    houseNumber: '12',
    postalCode: '8001',
    city: 'Zürich',
    country: 'CH',
  });
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: pin,
      })
    ).status(),
  ).toBe(201);

  const again = await request.post('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: {
      ...pin,
      street: 'Spitalgasse',
      houseNumber: '7',
      postalCode: '3011',
      city: 'Bern',
    },
  });
  expect(again.status()).toBe(200);

  const afterInsert = (await (await request.get('/map/places')).json()) as {
    places: Array<{
      name: string;
      street: string;
      houseNumber: string;
      postalCode: string;
      city: string;
    }>;
  };
  const stored = afterInsert.places.find((row) => row.name === 'Keep Address Pin');
  expect(stored?.street).toBe('Bahnhofstrasse');
  expect(stored?.houseNumber).toBe('12');
  expect(stored?.postalCode).toBe('8001');
  expect(stored?.city).toBe('Zürich');

  const bad = await request.put('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { ...pin, street: '  ' },
  });
  expect(bad.status()).toBe(400);
  expect(await bad.json()).toEqual({ error: 'Place street is invalid' });

  const afterBad = (await (await request.get('/map/places')).json()) as {
    places: Array<{
      name: string;
      street: string;
      houseNumber: string;
      postalCode: string;
      city: string;
    }>;
  };
  const unchanged = afterBad.places.find((row) => row.name === 'Keep Address Pin');
  expect(unchanged?.street).toBe('Bahnhofstrasse');
  expect(unchanged?.houseNumber).toBe('12');
  expect(unchanged?.postalCode).toBe('8001');
  expect(unchanged?.city).toBe('Zürich');

  const replaced = await request.put('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: {
      ...pin,
      name: 'Keep Address Pin',
      street: 'Limmatquai',
      houseNumber: '4',
      postalCode: '8400',
      city: 'Winterthur',
    },
  });
  expect(replaced.status()).toBe(200);

  const afterReplace = (await (await request.get('/map/places')).json()) as {
    places: Array<{
      name: string;
      street: string;
      houseNumber: string;
      postalCode: string;
      city: string;
    }>;
  };
  const updated = afterReplace.places.find((row) => row.name === 'Keep Address Pin');
  expect(updated?.street).toBe('Limmatquai');
  expect(updated?.houseNumber).toBe('4');
  expect(updated?.postalCode).toBe('8400');
  expect(updated?.city).toBe('Winterthur');

  const deleted = await request.delete('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { origin: 'dfx', externalId: 'e2e-keep-address' },
  });
  expect(deleted.status()).toBe(200);
  expect(await deleted.json()).toEqual({ deleted: true });
});

test('Function: SqliteMapPlaceStore — limit is applied after the country filter', async ({
  request,
}) => {
  const older = completePlace({
    externalId: 'e2e-limit-ch',
    name: 'Limit Older CH',
    country: 'CH',
    postalCode: '8001',
    city: 'Zürich',
    street: 'Bahnhofstrasse',
  });
  const newer = completePlace({
    externalId: 'e2e-limit-de',
    name: 'Limit Newer DE',
    country: 'DE',
    postalCode: '10115',
    city: 'Berlin',
    street: 'Other Street',
  });
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: older,
      })
    ).status(),
  ).toBe(201);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: newer,
      })
    ).status(),
  ).toBe(201);

  const newest = await request.get('/map/places?limit=1');
  expect(newest.status()).toBe(200);
  const newestJson = (await newest.json()) as { places: Array<{ name: string }> };
  expect(newestJson.places).toHaveLength(1);
  expect(newestJson.places[0]?.name).toBe('Limit Newer DE');

  const ch = await request.get('/map/places?limit=1&country=CH');
  expect(ch.status()).toBe(200);
  const chJson = (await ch.json()) as { places: Array<{ name: string }> };
  expect(chJson.places).toHaveLength(1);
  expect(chJson.places[0]?.name).toBe('Limit Older CH');
});

test('Function: SqliteMapPlaceStore — deleting a pin leaves the offer filter', async ({
  request,
}) => {
  const pin = completePlace({
    externalId: 'e2e-support-delete',
    name: 'Support Delete Pin',
    supports: [{ blockchain: 'Plasma', asset: 'ONDO' }],
  });
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: pin,
      })
    ).status(),
  ).toBe(201);
  const keep = completePlace({
    externalId: 'e2e-support-keep',
    name: 'Support Keep Pin',
    lat: 46.95,
    lon: 7.44,
    supports: [{ blockchain: 'Ethereum', asset: 'dEURO' }],
  });
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: keep,
      })
    ).status(),
  ).toBe(201);

  const filters = await request.get('/map/filters');
  expect(filters.status()).toBe(200);
  const filterJson = (await filters.json()) as {
    shopNames: string[];
    countries: string[];
    blockchains: string[];
    assets: string[];
  };
  expect(filterJson.blockchains).toContain('Plasma');
  expect(filterJson.assets).not.toContain('ONDO');

  const deleted = await request.delete('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { origin: 'dfx', externalId: 'e2e-support-delete' },
  });
  expect(deleted.status()).toBe(200);
  expect(await deleted.json()).toEqual({ deleted: true });

  const afterFilters = await request.get('/map/filters');
  expect(afterFilters.status()).toBe(200);
  const afterFilterJson = (await afterFilters.json()) as {
    shopNames: string[];
    countries: string[];
    blockchains: string[];
    assets: string[];
  };
  expect(afterFilterJson.blockchains).toContain('Plasma');
  expect(afterFilterJson.assets).not.toContain('ONDO');
  const plasmaFilters = await request.get('/map/filters?blockchain=Plasma');
  expect(plasmaFilters.status()).toBe(200);
  const plasmaJson = (await plasmaFilters.json()) as { assets: string[] };
  expect(plasmaJson.assets).toContain('USDT');
  expect(plasmaJson.assets).not.toContain('ONDO');

  const afterDelete = (await (await request.get('/map/places')).json()) as {
    places: Array<{ name: string }>;
  };
  expect(afterDelete.places.some((row) => row.name === 'Support Delete Pin')).toBe(false);
  expect(afterDelete.places.some((row) => row.name === 'Support Keep Pin')).toBe(true);

  const kept = await request.get('/map/places?blockchain=Ethereum&asset=dEURO');
  expect(kept.status()).toBe(200);
  const keptJson = (await kept.json()) as { places: Array<{ name: string }> };
  expect(keptJson.places.some((row) => row.name === 'Support Keep Pin')).toBe(true);
  expect(keptJson.places.some((row) => row.name === 'Support Delete Pin')).toBe(false);
});

test('Function: unstatedPaymentSql — a pin without supports uses the payment-link catalog', async ({
  request,
}) => {
  const dfx = completePlace({
    externalId: 'e2e-catalog-dfx',
    name: 'Catalog DFX Pin',
  });
  const gifts = completePlace({
    origin: '21gifts',
    externalId: 'e2e-catalog-gifts',
    name: 'Catalog Gifts Pin',
    lat: 14.62,
    lon: 120.96,
    category: 'shopping',
    techProvider: '21.gifts',
    shopType: 'Others',
    street: 'Santa Bakhita',
    houseNumber: '1',
    postalCode: '1011',
    city: 'Manila',
    country: 'PH',
  });
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: dfx,
      })
    ).status(),
  ).toBe(201);
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: gifts,
      })
    ).status(),
  ).toBe(201);

  const names = async (query: string): Promise<string[]> => {
    const response = await request.get(`/map/places?${query}`);
    expect(response.status()).toBe(200);
    const json = (await response.json()) as { places: Array<{ name: string }> };
    return json.places.map((row) => row.name);
  };

  expect(await names('blockchain=Ethereum')).toContain('Catalog DFX Pin');
  expect(await names('blockchain=Ethereum')).toContain('Catalog Gifts Pin');
  expect(await names('blockchain=Lightning&asset=BTC')).toEqual(
    expect.arrayContaining(['Catalog DFX Pin', 'Catalog Gifts Pin']),
  );
  expect(await names('blockchain=Ethereum&asset=BTC')).not.toContain('Catalog DFX Pin');
  expect(await names('blockchain=Ethereum&asset=BTC')).not.toContain('Catalog Gifts Pin');
  expect(await names('blockchain=BinancePay')).toContain('Catalog DFX Pin');
  expect(await names('blockchain=BinancePay')).not.toContain('Catalog Gifts Pin');
  expect(await names('asset=ckBTC')).toContain('Catalog DFX Pin');
  expect(await names('asset=ckBTC')).not.toContain('Catalog Gifts Pin');
  expect(await names('asset=dEURO')).toContain('Catalog DFX Pin');
  expect(await names('asset=LINK')).not.toContain('Catalog DFX Pin');
  expect(await names('blockchain=Plasma')).not.toContain('Catalog DFX Pin');
  expect(await names('blockchain=Plasma&asset=USDT')).toContain('Catalog Gifts Pin');
  expect(await names('blockchain=Arc&asset=USDC')).toContain('Catalog Gifts Pin');
  expect(await names('blockchain=Arc&asset=USDC')).not.toContain('Catalog DFX Pin');
  expect(await names('blockchain=Bitcoin')).not.toContain('Catalog Gifts Pin');
  expect(await names('blockchain=Spark&asset=BTC')).toContain('Catalog Gifts Pin');
  expect(await names('shopName=others')).toContain('Catalog Gifts Pin');
  expect(await names('shopType=SPAR')).toContain('Catalog DFX Pin');
  expect(await names('shopType=SPAR')).not.toContain('Catalog Gifts Pin');
  expect(await names('shopName=SPAR')).not.toContain('Catalog Gifts Pin');
});

test('Function: publicPlaceSupports — the tech provider offer is the public list', async ({
  request,
}) => {
  const dfx = completePlace({
    externalId: 'e2e-offer-dfx',
    name: 'Offer DFX Pin',
  });
  const gifts = completePlace({
    origin: '21gifts',
    externalId: 'e2e-offer-gifts',
    name: 'Offer Gifts Pin',
    lat: 14.6,
    lon: 121.0,
    category: 'shopping',
    techProvider: '21.gifts',
    shopType: 'Others',
    street: 'Rizal',
    houseNumber: '2',
    postalCode: '1000',
    city: 'Manila',
    country: 'PH',
  });
  const stated = completePlace({
    externalId: 'e2e-offer-stated',
    name: 'Offer Stated Pin',
    supports: [{ blockchain: 'Ethereum', asset: 'USDT' }],
  });
  const giftsOrigin = completePlace({
    origin: '21gifts',
    externalId: 'e2e-offer-gifts-origin',
    name: 'Offer Gifts Origin Pin',
    techProvider: 'DFX.swiss',
    lat: 14.61,
    lon: 120.98,
    category: 'shopping',
    shopType: 'Others',
    street: 'Rizal',
    houseNumber: '3',
    postalCode: '1000',
    city: 'Manila',
    country: 'PH',
  });
  const giftsLabel = completePlace({
    externalId: 'e2e-offer-gifts-label',
    name: 'Offer Gifts Label Pin',
    techProvider: '21.gifts',
    supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
  });
  for (const pin of [dfx, gifts, stated, giftsOrigin, giftsLabel]) {
    expect(
      (
        await request.post('/map/places', {
          headers: { Authorization: 'Bearer e2e-ingest' },
          data: pin,
        })
      ).status(),
    ).toBe(201);
  }

  const listed = await request.get('/map/places');
  expect(listed.status()).toBe(200);
  const json = (await listed.json()) as {
    places: Array<{
      name: string;
      supports: Array<{ blockchain: string; asset: string }>;
    }>;
  };
  const byName = (name: string) => json.places.find((row) => row.name === name);
  const dfxRow = byName('Offer DFX Pin');
  const giftsRow = byName('Offer Gifts Pin');
  const statedRow = byName('Offer Stated Pin');
  const giftsOriginRow = byName('Offer Gifts Origin Pin');
  const giftsLabelRow = byName('Offer Gifts Label Pin');
  expect(dfxRow?.supports).toEqual(publicPlaceSupports('DFX.swiss'));
  expect(giftsOriginRow?.supports).toEqual(publicPlaceSupports('DFX.swiss'));
  expect(giftsRow?.supports).toEqual(publicPlaceSupports('21.gifts'));
  expect(giftsLabelRow?.supports).toEqual(publicPlaceSupports('21.gifts'));
  expect(statedRow?.supports).toEqual(publicPlaceSupports('DFX.swiss'));
});

test('Function: matchesUnstatedPayment — 21.gifts follows its own offer', async ({ request }) => {
  const listed = await request.get('/map/places?blockchain=Lightning&asset=BTC');
  expect(listed.status()).toBe(200);
  const json = (await listed.json()) as { places: Array<{ name: string }> };
  expect(json.places.some((row) => row.name === 'Catalog Gifts Pin')).toBe(true);
  const hidden = await request.get('/map/places?asset=ZCHF');
  expect(hidden.status()).toBe(200);
  const hiddenJson = (await hidden.json()) as { places: Array<{ name: string }> };
  expect(hiddenJson.places.some((row) => row.name === 'Catalog Gifts Pin')).toBe(false);
});

test('Function: publicFilterResponse — filters include the payment-link catalog', async ({
  request,
}) => {
  const filters = await request.get('/map/filters');
  expect(filters.status()).toBe(200);
  const json = (await filters.json()) as {
    shopTypes: string[];
    shopNames: string[];
    blockchains: string[];
    assets: string[];
    activities: string[];
    techProviders: Array<{
      name: string;
      blockchains: string[];
      assets: string[];
      pairs: Array<{ blockchain: string; asset: string }>;
    }>;
  };
  expect(json.shopTypes).toEqual(['SPAR', 'Others']);
  expect(json.shopNames).toEqual(['SPAR', 'others']);
  expect(json.activities).toEqual([
    'daily',
    'within7Days',
    'within30Days',
    'olderThan30Days',
    'none',
  ]);
  expect(json.blockchains).toContain('Lightning');
  expect(json.blockchains).toContain('BinancePay');
  expect(json.blockchains).toContain('Plasma');
  expect(json.blockchains).toContain('Arc');
  expect(json.blockchains).not.toContain('Sepolia');
  expect(json.blockchains).not.toContain('Gnosis');
  expect(json.blockchains).not.toContain('Zano');
  expect(json.assets).toContain('ckBTC');
  expect(json.assets).not.toContain('USDC.e');
  expect(json.assets).not.toContain('USDbC');
  const dfx = json.techProviders.find((provider) => provider.name === 'DFX.swiss');
  const gifts = json.techProviders.find((provider) => provider.name === '21.gifts');
  expect(dfx?.pairs).toContainEqual({ blockchain: 'Ethereum', asset: 'ZCHF' });
  expect(dfx?.pairs).toContainEqual({ blockchain: 'Polygon', asset: 'ZCHF' });
  expect(dfx?.pairs).not.toContainEqual({ blockchain: 'Ethereum', asset: 'BTC' });
  expect(dfx?.blockchains).not.toContain('Plasma');
  expect(dfx?.blockchains).not.toContain('Gnosis');
  expect(dfx?.blockchains).not.toContain('Zano');
  expect(gifts?.name).toBe('21.gifts');
  expect(gifts?.pairs).toEqual(publicPlaceSupports('21.gifts'));
  expect(gifts?.pairs).toContainEqual({ blockchain: 'Lightning', asset: 'BTC' });
  expect(gifts?.pairs).toContainEqual({ blockchain: 'Spark', asset: 'BTC' });
  expect(gifts?.pairs).toContainEqual({ blockchain: 'Ethereum', asset: 'USDT' });
  expect(gifts?.pairs).not.toContainEqual({ blockchain: 'Bitcoin', asset: 'BTC' });
  const ethereum = await request.get('/map/filters?blockchain=Ethereum');
  expect(ethereum.status()).toBe(200);
  const ethereumJson = (await ethereum.json()) as {
    assets: string[];
    blockchains: string[];
    activities: string[];
  };
  expect(ethereumJson.assets).toContain('ZCHF');
  expect(ethereumJson.assets).toContain('USDT');
  expect(ethereumJson.assets).not.toContain('BTC');
  expect(ethereumJson.blockchains).toContain('Polygon');
  expect(ethereumJson.activities).toEqual([
    'daily',
    'within7Days',
    'within30Days',
    'olderThan30Days',
    'none',
  ]);
});

test('Function: isCatalogBlockchain — BinancePay is a filter and Kraken is not', async ({
  request,
}) => {
  expect((await request.get('/map/places?blockchain=BinancePay')).status()).toBe(200);
  expect((await request.get('/map/places?blockchain=Kraken')).status()).toBe(400);
  expect((await request.get('/map/filters?blockchain=KucoinPay')).status()).toBe(200);
  expect((await request.get('/map/filters?blockchain=Frick')).status()).toBe(400);
});

test('Function: isCatalogAsset — catalog asset names are filter queries', async ({ request }) => {
  expect((await request.get('/map/places?asset=ckBTC')).status()).toBe(200);
  expect((await request.get('/map/places?asset=USDC.e')).status()).toBe(400);
  expect((await request.get('/map/places?asset=USDbC')).status()).toBe(400);
  expect((await request.get('/map/places?asset=dEURO')).status()).toBe(200);
  expect((await request.get('/map/places?asset=Ethereum/ZCHF')).status()).toBe(400);
});

test('Function: placeActivity — a recorded transaction is within7Days', async ({ request }) => {
  const pin = completePlace({
    externalId: 'e2e-activity-recent',
    name: 'Activity Recent Pin',
  });
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: pin,
      })
    ).status(),
  ).toBe(201);
  const recorded = await request.post('/map/places/transactions', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { origin: 'dfx', externalId: 'e2e-activity-recent' },
  });
  expect(recorded.status()).toBe(200);
  expect(await recorded.json()).toEqual({ activity: 'within7Days' });
  const listed = await request.get('/map/places');
  const json = (await listed.json()) as { places: Array<{ name: string; activity: string }> };
  expect(
    json.places.some((row) => row.name === 'Activity Recent Pin' && row.activity === 'within7Days'),
  ).toBe(true);

  const missing = await request.post('/map/places/transactions', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { origin: 'dfx', externalId: 'e2e-activity-missing' },
  });
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toEqual({ error: 'Place not found' });
});

test('Function: placeActivity — five UTC days in the window are daily', async ({ request }) => {
  const pin = completePlace({
    externalId: 'e2e-activity-daily',
    name: 'Activity Daily Pin',
  });
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: pin,
      })
    ).status(),
  ).toBe(201);
  const nowMs = Date.now();
  let lastActivity: unknown;
  for (let i = 4; i >= 0; i -= 1) {
    const occurredAt = new Date(nowMs - i * 24 * 60 * 60 * 1000).toISOString();
    const recorded = await request.post('/map/places/transactions', {
      headers: { Authorization: 'Bearer e2e-ingest' },
      data: { origin: 'dfx', externalId: 'e2e-activity-daily', occurredAt },
    });
    expect(recorded.status()).toBe(200);
    lastActivity = await recorded.json();
  }
  expect(lastActivity).toEqual({ activity: 'daily' });
  const listed = await request.get('/map/places');
  const json = (await listed.json()) as { places: Array<{ name: string; activity: string }> };
  expect(
    json.places.some((row) => row.name === 'Activity Daily Pin' && row.activity === 'daily'),
  ).toBe(true);
});

test('Function: placeActivity — an instant older than 30 days is olderThan30Days', async ({
  request,
}) => {
  const pin = completePlace({
    externalId: 'e2e-activity-old',
    name: 'Activity Old Pin',
  });
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: pin,
      })
    ).status(),
  ).toBe(201);
  const occurredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const recorded = await request.post('/map/places/transactions', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { origin: 'dfx', externalId: 'e2e-activity-old', occurredAt },
  });
  expect(recorded.status()).toBe(200);
  expect(await recorded.json()).toEqual({ activity: 'olderThan30Days' });
  const listed = await request.get('/map/places');
  const json = (await listed.json()) as { places: Array<{ name: string; activity: string }> };
  expect(
    json.places.some(
      (row) => row.name === 'Activity Old Pin' && row.activity === 'olderThan30Days',
    ),
  ).toBe(true);
});

test('Function: normalizePlaceTransaction — a future occurredAt beyond skew is 400', async ({
  request,
}) => {
  const occurredAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();
  const res = await request.post('/map/places/transactions', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { origin: 'dfx', externalId: 'e2e-activity-recent', occurredAt },
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ error: 'Place transaction time is invalid' });
});

test('Function: SqliteMapPlaceStore — old schema hides incomplete rows; listAll returns incomplete rows and loads supports in chunks', () => {
  const stdout = execFileSync('bun', ['e2e/sqlite-backfill.ts'], { encoding: 'utf8' });
  expect(stdout.trim()).toBe('ok');
});

test('Function: isNostrPubkey — an invalid key is 400 and a shop without a key is 400 (step 1b)', async ({
  request,
}) => {
  const invalid = await request.post('/map/places', {
    headers: ingest,
    data: completePlace({ externalId: 'e2e-bad-key', nostrPubkey: 'f'.repeat(64) }),
  });
  expect(invalid.status()).toBe(400);
  expect(await invalid.json()).toEqual({ error: 'Place NOSTR public key is invalid' });
  const keyless = await request.post('/map/places', {
    headers: ingest,
    data: keylessPlace({ externalId: 'e2e-keyless', name: 'Keyless SPAR' }),
  });
  expect(keyless.status()).toBe(400);
  expect(await keyless.json()).toEqual({ error: 'Place NOSTR public key is required' });
  const listed = (await (await request.get('/map/places')).json()) as {
    places: Array<{ name: string }>;
  };
  expect(listed.places.some((row) => row.name === 'Keyless SPAR')).toBe(false);
});

test('Function: npubEncode — the answer id is the npub and GET /map/places/:id serves the shop', async ({
  request,
}) => {
  const key = keyFor('e2e-identity');
  const npub = npubEncode(key);
  const added = await request.post('/map/places', {
    headers: ingest,
    data: completePlace({ externalId: 'e2e-identity', name: 'Identity SPAR', nostrPubkey: key }),
  });
  expect(added.status()).toBe(201);
  expect(await added.json()).toMatchObject({ created: true, id: npub });
  const detail = await request.get(`/map/places/${npub}`);
  expect(detail.status()).toBe(200);
  expect(detail.headers()['cache-control']).toBe('public, max-age=60');
  const json = (await detail.json()) as { place: { id: string; name: string } };
  expect(json.place).toMatchObject({ id: npub, name: 'Identity SPAR' });
  const listed = (await (await request.get('/map/places')).json()) as {
    places: Array<{ id: string }>;
  };
  expect(listed.places.some((row) => row.id === npub)).toBe(true);
  const hex = await request.get(`/map/places/${key}`, { maxRedirects: 0 });
  expect(hex.status()).toBe(301);
  expect(hex.headers()['location']).toBe(`/map/places/${npub}`);
});

test('Function: npubDecode — GET /map/places/:id answers 404 for anything that is not a listed shop', async ({
  request,
}) => {
  const literal = await request.get('/map/places/:id');
  expect(literal.status()).toBe(404);
  expect(await literal.json()).toEqual({ error: 'Place not found' });
  const unknown = await request.get(`/map/places/${npubEncode(keyFor('e2e-never-stored'))}`);
  expect(unknown.status()).toBe(404);
  expect(unknown.headers()['cache-control']).toBe('public, max-age=60');
});

test('Function: placeWriteConflict — a changed key, a taken key and a stale revision are 409', async ({
  request,
}) => {
  const key = keyFor('e2e-conflict');
  const first = await request.put('/map/places', {
    headers: ingest,
    data: completePlace({
      externalId: 'e2e-conflict',
      name: 'Conflict Pin',
      nostrPubkey: key,
      revision: 2,
    }),
  });
  expect(first.status()).toBe(201);
  const changed = await request.put('/map/places', {
    headers: ingest,
    data: completePlace({
      externalId: 'e2e-conflict',
      nostrPubkey: keyFor('e2e-conflict-other'),
      revision: 3,
    }),
  });
  expect(changed.status()).toBe(409);
  expect(await changed.json()).toEqual({ error: 'nostrPubkey of a place cannot change' });
  const taken = await request.post('/map/places', {
    headers: ingest,
    data: completePlace({ externalId: 'e2e-conflict-2', nostrPubkey: key }),
  });
  expect(taken.status()).toBe(409);
  expect(await taken.json()).toEqual({ error: 'nostrPubkey belongs to another place' });
  const stale = await request.put('/map/places', {
    headers: ingest,
    data: completePlace({ externalId: 'e2e-conflict', nostrPubkey: key, revision: 2 }),
  });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toEqual({ error: 'Stale revision' });
});

test('Function: placeNameConflict — a second shop with the same name is 409 and the own name still updates', async ({
  request,
}) => {
  const firstKey = keyFor('e2e-name-1');
  const created = await request.post('/map/places', {
    headers: ingest,
    data: completePlace({
      externalId: 'e2e-name-1',
      name: 'Exact Name Shop',
      nostrPubkey: firstKey,
    }),
  });
  expect(created.status()).toBe(201);
  const duplicate = await request.post('/map/places', {
    headers: ingest,
    data: completePlace({
      externalId: 'e2e-name-2',
      name: 'Exact Name Shop',
      nostrPubkey: keyFor('e2e-name-2'),
    }),
  });
  expect(duplicate.status()).toBe(409);
  expect(await duplicate.json()).toEqual({ error: 'Place name belongs to another place' });
  const listed = (await (await request.get('/map/places')).json()) as {
    places: Array<{ name: string }>;
  };
  expect(listed.places.filter((row) => row.name === 'Exact Name Shop')).toHaveLength(1);
  const kept = await request.put('/map/places', {
    headers: ingest,
    data: completePlace({
      externalId: 'e2e-name-1',
      name: 'Exact Name Shop',
      nostrPubkey: firstKey,
    }),
  });
  expect(kept.status()).toBe(200);
  const after = (await (await request.get('/map/places')).json()) as {
    places: Array<{ name: string }>;
  };
  expect(after.places.filter((row) => row.name === 'Exact Name Shop')).toHaveLength(1);
});

test('Function: normalizeMapPlaceDelete — DELETE refuses another key, keeps the revision and the reservation', async ({
  request,
}) => {
  const key = keyFor('e2e-delete-order');
  await request.put('/map/places', {
    headers: ingest,
    data: completePlace({
      externalId: 'e2e-delete-order',
      name: 'Delete Order Pin',
      nostrPubkey: key,
      revision: 1,
    }),
  });
  const extra = await request.delete('/map/places', {
    headers: ingest,
    data: { origin: 'dfx', externalId: 'e2e-delete-order', name: 'x' },
  });
  expect(extra.status()).toBe(400);
  expect(await extra.json()).toEqual({ error: 'Place field is not allowed: name' });
  const stale = await request.delete('/map/places', {
    headers: ingest,
    data: { origin: 'dfx', externalId: 'e2e-delete-order', revision: 1 },
  });
  expect(stale.status()).toBe(409);
  const removed = await request.delete('/map/places', {
    headers: ingest,
    data: { origin: 'dfx', externalId: 'e2e-delete-order', revision: 2 },
  });
  expect(await removed.json()).toEqual({ deleted: true });
  const late = await request.put('/map/places', {
    headers: ingest,
    data: completePlace({ externalId: 'e2e-delete-order', nostrPubkey: key, revision: 2 }),
  });
  expect(late.status()).toBe(409);
  const moved = await request.post('/map/places', {
    headers: ingest,
    data: completePlace({ externalId: 'e2e-delete-moved', nostrPubkey: key }),
  });
  expect(moved.status()).toBe(409);
  expect(await moved.json()).toEqual({ error: 'nostrPubkey belongs to another place' });
});

async function shopWithKey(
  request: import('@playwright/test').APIRequestContext,
  externalId: string,
): Promise<string> {
  const key = keyFor(`dfx/${externalId}`);
  const res = await request.put('/map/places', {
    headers: ingest,
    data: completePlace({ externalId, name: `Photo Shop ${externalId}`, nostrPubkey: key }),
  });
  expect(res.status()).toBe(201);
  return key;
}

test('Function: normalizePhotoUpload — PUT /map/places/photos rejects a malformed envelope and an unknown shop', async ({
  request,
}) => {
  const key = await shopWithKey(request, 'e2e-photo-envelope');
  const bad = await request.put('/map/places/photos', {
    headers: ingest,
    data: { origin: 'dfx', nostrPubkey: key, photos: 'x' },
  });
  expect(bad.status()).toBe(400);
  expect(await bad.json()).toEqual({ error: 'Photos must be a list of at most 10' });
  const unknown = await request.put('/map/places/photos', {
    headers: ingest,
    data: { origin: 'spar', nostrPubkey: key, photos: [] },
  });
  expect(unknown.status()).toBe(404);
  const unauthorized = await request.put('/map/places/photos', { data: {} });
  expect(unauthorized.status()).toBe(401);
});

test('Function: stripPhotoMetadata — a stored photo keeps only the EXIF orientation and carries no GPS, text or trailing bytes', async ({
  request,
}) => {
  const key = await shopWithKey(request, 'e2e-photo-strip');
  const withGps = jpeg(
    [
      jpegSegment(0xe1, bytesOf('Exif\0\0', exifTiff('MM', 6))),
      jpegSegment(0xe1, bytesOf('http://ns.adobe.com/xap/1.0/\0', 'GPSLatitude 47.3')),
      jpegSegment(0xfe, 'shot by Alice'),
      jpegSegment(0xdb, new Uint8Array(65)),
      sof(40, 30),
      scan(),
    ],
    [0x99, 0x98, 0x97],
  );
  const stored = await request.put('/map/places/photos', {
    headers: ingest,
    data: {
      origin: 'dfx',
      nostrPubkey: key,
      photos: [{ contentType: 'image/jpeg', data: base64(withGps), caption: 'Front' }],
    },
  });
  expect(stored.status()).toBe(200);
  const json = (await stored.json()) as {
    photos: Array<{ url: string; width: number; height: number; caption: string }>;
    skipped: unknown[];
  };
  expect(json.skipped).toEqual([]);
  expect(json.photos[0]).toMatchObject({ width: 30, height: 40, caption: 'Front' });
  expect(json.photos[0]?.url).toMatch(
    /^https:\/\/api\.e2e\.test\/map\/photos\/[0-9a-f]{64}\.jpg$/u,
  );
  const served = await request.get(new URL(json.photos[0]?.url ?? '').pathname);
  expect(served.status()).toBe(200);
  const body = Buffer.from(await served.body());
  expect(body.includes('GPSLatitude')).toBe(false);
  expect(body.includes('Alice')).toBe(false);
  expect(body.includes(Buffer.from([0x99, 0x98, 0x97]))).toBe(false);
  expect(body.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
});

test('Function: stripPhotoMetadata — a WebP whose VP8X canvas hides an oversized frame is skipped', async ({
  request,
}) => {
  const key = await shopWithKey(request, 'e2e-photo-webp-canvas');
  const stored = await request.put('/map/places/photos', {
    headers: ingest,
    data: {
      origin: 'dfx',
      nostrPubkey: key,
      photos: [
        {
          contentType: 'image/webp',
          data: base64(
            webp([webpChunk('VP8X', vp8x(0, 1, 1)), webpChunk('VP8 ', vp8(16383, 16383))]),
          ),
        },
        {
          contentType: 'image/webp',
          data: base64(
            webp([webpChunk('VP8X', vp8x(0, 1, 1)), webpChunk('VP8L', vp8l(16384, 16384))]),
          ),
        },
        {
          contentType: 'image/webp',
          data: base64(webp([webpChunk('VP8X', vp8x(0, 6, 5)), webpChunk('VP8 ', vp8(6, 5))])),
        },
      ],
    },
  });
  expect(stored.status()).toBe(200);
  const json = (await stored.json()) as { photos: Array<{ url: string }>; skipped: unknown[] };
  expect(json.skipped).toEqual([
    { index: 0, error: 'Photo 1 could not be read' },
    { index: 1, error: 'Photo 2 could not be read' },
  ]);
  expect(json.photos).toHaveLength(1);
  expect(json.photos[0]?.url.endsWith('.webp')).toBe(true);
});

test('Function: stripPhotoMetadata — a JPEG whose small first SOF hides an oversized second SOF is skipped', async ({
  request,
}) => {
  const key = await shopWithKey(request, 'e2e-photo-jpeg-sof');
  const dqt = jpegSegment(0xdb, new Uint8Array(65));
  const stored = await request.put('/map/places/photos', {
    headers: ingest,
    data: {
      origin: 'dfx',
      nostrPubkey: key,
      photos: [
        {
          contentType: 'image/jpeg',
          data: base64(jpeg([dqt, sof(1, 1), sof(65535, 65535), scan()])),
        },
        { contentType: 'image/jpeg', data: base64(jpeg([dqt, sof(0, 1), sof(2, 1), scan()])) },
        { contentType: 'image/jpeg', data: base64(jpeg([dqt, sof(6, 5), scan()])) },
      ],
    },
  });
  expect(stored.status()).toBe(200);
  const json = (await stored.json()) as { photos: Array<{ url: string }>; skipped: unknown[] };
  expect(json.skipped).toEqual([
    { index: 0, error: 'Photo 1 could not be read' },
    { index: 1, error: 'Photo 2 could not be read' },
  ]);
  expect(json.photos).toHaveLength(1);
  expect(json.photos[0]?.url.endsWith('.jpg')).toBe(true);
});

test('Function: stripPhotoMetadata — a JPEG whose small SOF hides a large DNL height is skipped', async ({
  request,
}) => {
  const key = await shopWithKey(request, 'e2e-photo-jpeg-dnl');
  const dqt = jpegSegment(0xdb, new Uint8Array(65));
  const stored = await request.put('/map/places/photos', {
    headers: ingest,
    data: {
      origin: 'dfx',
      nostrPubkey: key,
      photos: [
        {
          contentType: 'image/jpeg',
          data: base64(jpeg([dqt, sof(6, 1), scan(), jpegSegment(0xdc, [0xff, 0xff])])),
        },
        { contentType: 'image/jpeg', data: base64(jpeg([dqt, sof(6, 5), scan()])) },
      ],
    },
  });
  expect(stored.status()).toBe(200);
  const json = (await stored.json()) as { photos: Array<{ url: string }>; skipped: unknown[] };
  expect(json.skipped).toEqual([{ index: 0, error: 'Photo 1 could not be read' }]);
  expect(json.photos).toHaveLength(1);
  expect(json.photos[0]?.url.endsWith('.jpg')).toBe(true);
});

test('Function: preparePhoto — a bad photo is skipped by index and the others are stored in order', async ({
  request,
}) => {
  const key = await shopWithKey(request, 'e2e-photo-skip');
  const stored = await request.put('/map/places/photos', {
    headers: ingest,
    data: {
      origin: 'dfx',
      nostrPubkey: key,
      photos: [
        { contentType: 'image/png', data: base64(simplePng(3, 2)) },
        { contentType: 'image/png', data: base64(simpleJpeg()) },
        { contentType: 'image/webp', data: base64(simpleWebp(4, 3)) },
      ],
    },
  });
  const json = (await stored.json()) as { photos: Array<{ url: string }>; skipped: unknown[] };
  expect(json.skipped).toEqual([{ index: 1, error: 'Photo 2 does not match its content type' }]);
  expect(json.photos.map((photo) => photo.url.slice(-4))).toEqual(['.png', 'webp']);
});

test('Function: toPublicMapPlaceDetail — the list shows the cover photo and the detail every photo', async ({
  request,
}) => {
  const key = await shopWithKey(request, 'e2e-photo-detail');
  const stored = (await (
    await request.put('/map/places/photos', {
      headers: ingest,
      data: {
        origin: 'dfx',
        nostrPubkey: key,
        photos: [
          { contentType: 'image/png', data: base64(simplePng(3, 2)), caption: 'Front' },
          { contentType: 'image/webp', data: base64(simpleWebp(4, 3)) },
        ],
      },
    })
  ).json()) as { photos: Array<{ url: string }> };
  const listed = (await (await request.get('/map/places')).json()) as {
    places: Array<{ id: string; coverPhoto: unknown }>;
  };
  expect(listed.places.find((row) => row.id === npubEncode(key))?.coverPhoto).toEqual({
    url: stored.photos[0]?.url,
    width: 3,
    height: 2,
  });
  const detail = (await (await request.get(`/map/places/${npubEncode(key)}`)).json()) as {
    place: { photos: Array<{ url: string; caption: string | null }> };
  };
  expect(detail.place.photos.map((photo) => photo.caption)).toEqual(['Front', null]);
});

test('Function: photoExtension — GET /map/photos/:file answers 404 for a wrong extension or an unknown file', async ({
  request,
}) => {
  const literal = await request.get('/map/photos/:file');
  expect(literal.status()).toBe(404);
  expect(literal.headers()['cache-control']).toBe('no-store');
  const key = await shopWithKey(request, 'e2e-photo-ext');
  const stored = (await (
    await request.put('/map/places/photos', {
      headers: ingest,
      data: {
        origin: 'dfx',
        nostrPubkey: key,
        photos: [{ contentType: 'image/png', data: base64(simplePng()) }],
      },
    })
  ).json()) as { photos: Array<{ url: string }> };
  const path = new URL(stored.photos[0]?.url ?? '').pathname;
  const ok = await request.get(path);
  expect(ok.status()).toBe(200);
  expect(ok.headers()['content-type']).toBe('image/png');
  expect(ok.headers()['x-content-type-options']).toBe('nosniff');
  expect(ok.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect((await request.get(path.replace('.png', '.webp'))).status()).toBe(404);
});

test('Function: SqliteMapPlaceStore — a deleted shop no longer serves its photos', async ({
  request,
}) => {
  const key = await shopWithKey(request, 'e2e-photo-delete');
  const stored = (await (
    await request.put('/map/places/photos', {
      headers: ingest,
      data: {
        origin: 'dfx',
        nostrPubkey: key,
        photos: [{ contentType: 'image/png', data: base64(simplePng(7, 7)) }],
      },
    })
  ).json()) as { photos: Array<{ url: string }> };
  const path = new URL(stored.photos[0]?.url ?? '').pathname;
  expect((await request.get(path)).status()).toBe(200);
  await request.delete('/map/places', {
    headers: ingest,
    data: { origin: 'dfx', externalId: 'e2e-photo-delete' },
  });
  expect((await request.get(path)).status()).toBe(404);
});

test('Function: parsePublicBaseUrl — photo URLs use OCP_PUBLIC_BASE_URL, not the request host', async ({
  request,
}) => {
  const key = await shopWithKey(request, 'e2e-photo-base');
  const stored = (await (
    await request.put('/map/places/photos', {
      headers: { ...ingest, Host: 'evil.example' },
      data: {
        origin: 'dfx',
        nostrPubkey: key,
        photos: [{ contentType: 'image/png', data: base64(simplePng(9, 9)) }],
      },
    })
  ).json()) as { photos: Array<{ url: string }> };
  expect(stored.photos[0]?.url.startsWith('https://api.e2e.test/map/photos/')).toBe(true);
});

test('Function: photoTypeOf — a photo whose magic bytes name another type is skipped', async ({
  request,
}) => {
  const key = await shopWithKey(request, 'e2e-photo-magic');
  const stored = await request.put('/map/places/photos', {
    headers: ingest,
    data: {
      origin: 'dfx',
      nostrPubkey: key,
      photos: [
        { contentType: 'image/jpeg', data: base64(simplePng()) },
        { contentType: 'image/webp', data: base64(simpleWebp()) },
      ],
    },
  });
  expect(stored.status()).toBe(200);
  const json = (await stored.json()) as { photos: unknown[]; skipped: unknown[] };
  expect(json.skipped).toEqual([{ index: 0, error: 'Photo 1 does not match its content type' }]);
  expect(json.photos).toHaveLength(1);
});

test('Function: publicPhoto — the photo answer and the detail use the same URL', async ({
  request,
}) => {
  const key = await shopWithKey(request, 'e2e-photo-url');
  const stored = (await (
    await request.put('/map/places/photos', {
      headers: ingest,
      data: {
        origin: 'dfx',
        nostrPubkey: key,
        photos: [{ contentType: 'image/png', data: base64(simplePng(11, 5)) }],
      },
    })
  ).json()) as { photos: Array<{ url: string }> };
  const detail = (await (await request.get(`/map/places/${npubEncode(key)}`)).json()) as {
    place: { photos: Array<{ url: string }> };
  };
  expect(detail.place.photos[0]?.url).toBe(stored.photos[0]?.url);
});
