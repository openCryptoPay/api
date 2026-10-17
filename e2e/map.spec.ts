import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

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
  };
}

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
    data: completePlace({ externalId: 'e2e-public' }),
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

  expect(await names('blockchain=Ethereum&asset=ZCHF')).not.toContain('Split Pair Pin');
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
  expect(updated?.supports).toEqual([]);
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

test('Function: SqliteMapPlaceStore — delete removes the pin and its support from filters', async ({
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
  expect(filterJson.assets).toContain('ONDO');

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
  expect(afterFilterJson.blockchains).not.toContain('Plasma');
  const plasmaFilters = await request.get('/map/filters?blockchain=Plasma');
  expect(plasmaFilters.status()).toBe(200);
  const plasmaJson = (await plasmaFilters.json()) as { assets: string[] };
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
  expect(await names('blockchain=Ethereum')).not.toContain('Catalog Gifts Pin');
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
  expect(await names('shopName=others')).toContain('Catalog Gifts Pin');
  expect(await names('shopType=SPAR')).toContain('Catalog DFX Pin');
  expect(await names('shopType=SPAR')).not.toContain('Catalog Gifts Pin');
  expect(await names('shopName=SPAR')).not.toContain('Catalog Gifts Pin');
});

test('Function: matchesUnstatedPayment — 21.gifts stays on Lightning and BTC', async ({
  request,
}) => {
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
    techProviders: Array<{
      name: string;
      blockchains: string[];
      assets: string[];
      pairs: Array<{ blockchain: string; asset: string }>;
    }>;
  };
  expect(json.shopTypes).toEqual(['SPAR', 'Others']);
  expect(json.shopNames).toEqual(['SPAR', 'others']);
  expect(json.blockchains).toContain('Lightning');
  expect(json.blockchains).toContain('BinancePay');
  expect(json.blockchains).not.toContain('Sepolia');
  expect(json.assets).toContain('ckBTC');
  expect(json.assets).not.toContain('USDC.e');
  expect(json.assets).not.toContain('USDbC');
  const dfx = json.techProviders.find((provider) => provider.name === 'DFX.swiss');
  const gifts = json.techProviders.find((provider) => provider.name === '21.gifts');
  expect(dfx?.pairs).toContainEqual({ blockchain: 'Ethereum', asset: 'ZCHF' });
  expect(dfx?.pairs).toContainEqual({ blockchain: 'Polygon', asset: 'ZCHF' });
  expect(dfx?.pairs).not.toContainEqual({ blockchain: 'Ethereum', asset: 'BTC' });
  expect(dfx?.blockchains).not.toContain('Plasma');
  expect(gifts).toEqual({
    name: '21.gifts',
    blockchains: ['Lightning'],
    assets: ['BTC'],
    pairs: [{ blockchain: 'Lightning', asset: 'BTC' }],
  });
  const ethereum = await request.get('/map/filters?blockchain=Ethereum');
  expect(ethereum.status()).toBe(200);
  const ethereumJson = (await ethereum.json()) as { assets: string[]; blockchains: string[] };
  expect(ethereumJson.assets).toContain('ZCHF');
  expect(ethereumJson.assets).not.toContain('BTC');
  expect(ethereumJson.blockchains).toContain('Polygon');
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

test('Function: SqliteMapPlaceStore — opening an old schema hides incomplete rows', () => {
  const stdout = execFileSync('bun', ['e2e/sqlite-backfill.ts'], { encoding: 'utf8' });
  expect(stdout.trim()).toBe('ok');
});
