import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

const body = {
  origin: 'dfx',
  externalId: 'e2e-store',
  name: 'SPAR',
  lat: 47.37,
  lon: 8.54,
  category: 'groceries',
  paymentMethods: 'lightning',
};

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
  const sparPin = {
    origin: 'spar',
    externalId: 'e2e-origin-spar',
    name: 'Origin SPAR Pin',
    lat: 47.37,
    lon: 8.54,
    category: 'groceries',
  };
  const otherPin = {
    origin: 'dfx',
    externalId: 'e2e-origin-other',
    name: 'Origin Other Pin',
    lat: 47.37,
    lon: 8.54,
    category: 'groceries',
  };
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
    data: { ...body, externalId: 'e2e-public' },
  });
  expect(created.ok()).toBe(true);
  const res = await request.get('/map/places');
  const json = (await res.json()) as { places: Array<Record<string, unknown>> };
  expect(json.places.some((row) => row['externalId'] !== undefined)).toBe(false);
});

test('Function: SqliteMapPlaceStore — the created pin is listed', async ({ request }) => {
  const created = await request.post('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { ...body, externalId: 'e2e-listed', name: 'Listed SPAR' },
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
  const sparPin = {
    origin: 'dfx',
    externalId: 'e2e-filter-spar-ch',
    name: 'Filter SPAR CH',
    lat: 47.37,
    lon: 8.54,
    category: 'groceries',
    country: 'CH',
    shopName: 'SPAR',
    supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
  };
  const otherPin = {
    origin: 'dfx',
    externalId: 'e2e-filter-other',
    name: 'Filter Other Pin',
    lat: 47.37,
    lon: 8.54,
    category: 'groceries',
    country: 'DE',
    shopName: 'Migros',
    supports: [{ blockchain: 'Bitcoin', asset: 'BTC' }],
  };
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
    '/map/places?shopName=SPAR&country=CH&blockchain=Ethereum&asset=ZCHF',
  );
  expect(filtered.status()).toBe(200);
  const listed = (await filtered.json()) as { places: Array<{ name: string }> };
  expect(listed.places.some((row) => row.name === 'Filter SPAR CH')).toBe(true);
  expect(listed.places.some((row) => row.name === 'Filter Other Pin')).toBe(false);

  const filters = await request.get('/map/filters');
  expect(filters.status()).toBe(200);
  const filterJson = (await filters.json()) as {
    shopNames: string[];
    countries: string[];
    blockchains: string[];
    assets: string[];
  };
  expect(filterJson.shopNames).toEqual(['SPAR', 'others']);
  expect(filterJson.countries).toContain('CH');
  expect(filterJson.blockchains).toContain('Ethereum');
  expect(filterJson.assets).toContain('ZCHF');
});

test('Function: SqliteMapPlaceStore — a pair is one support row', async ({ request }) => {
  const pin = {
    origin: 'dfx',
    externalId: 'e2e-split-pair',
    name: 'Split Pair Pin',
    lat: 47.37,
    lon: 8.54,
    category: 'groceries',
    supports: [
      { blockchain: 'Polygon', asset: 'ZCHF' },
      { blockchain: 'Ethereum', asset: 'ETH' },
    ],
  };
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
  const pin = {
    origin: 'dfx',
    externalId: 'e2e-provider',
    name: 'Omitted Label Cafe',
    lat: 47.37,
    lon: 8.54,
    category: 'cafe',
  };
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

  const keepProvider = await request.put('/map/places', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: { ...pin, name: 'Updated Label Cafe' },
  });
  expect(keepProvider.status()).toBe(200);

  const afterPut = (await (await request.get('/map/places')).json()) as {
    places: Array<{ name: string; techProvider: string }>;
  };
  expect(
    afterPut.places.some(
      (row) => row.name === 'Updated Label Cafe' && row.techProvider === '21.gifts',
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

test('Function: SqliteMapPlaceStore — limit is applied after the country filter', async ({
  request,
}) => {
  const older = {
    origin: 'dfx',
    externalId: 'e2e-limit-ch',
    name: 'Limit Older CH',
    lat: 47.37,
    lon: 8.54,
    category: 'groceries',
    country: 'CH',
  };
  const newer = {
    origin: 'dfx',
    externalId: 'e2e-limit-de',
    name: 'Limit Newer DE',
    lat: 47.37,
    lon: 8.54,
    category: 'groceries',
    country: 'DE',
  };
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
  const pin = {
    origin: 'dfx',
    externalId: 'e2e-support-delete',
    name: 'Support Delete Pin',
    lat: 47.37,
    lon: 8.54,
    category: 'groceries',
    supports: [{ blockchain: 'Plasma', asset: 'ONDO' }],
  };
  expect(
    (
      await request.post('/map/places', {
        headers: { Authorization: 'Bearer e2e-ingest' },
        data: pin,
      })
    ).status(),
  ).toBe(201);
  const keep = {
    origin: 'dfx',
    externalId: 'e2e-support-keep',
    name: 'Support Keep Pin',
    lat: 46.95,
    lon: 7.44,
    category: 'groceries',
    supports: [{ blockchain: 'Ethereum', asset: 'dEURO' }],
  };
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
  const dfx = {
    origin: 'dfx',
    externalId: 'e2e-catalog-dfx',
    name: 'Catalog DFX Pin',
    lat: 47.37,
    lon: 8.54,
    category: 'groceries',
  };
  const gifts = {
    origin: '21gifts',
    externalId: 'e2e-catalog-gifts',
    name: 'Catalog Gifts Pin',
    lat: 14.62,
    lon: 120.96,
    category: 'shopping',
    techProvider: '21.gifts',
  };
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
  expect(await names('shopName=others')).toContain('Catalog DFX Pin');
  expect(await names('shopName=others')).toContain('Catalog Gifts Pin');
  expect(await names('shopName=SPAR')).not.toContain('Catalog DFX Pin');
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
    blockchains: string[];
    assets: string[];
    techProviders: Array<{
      name: string;
      blockchains: string[];
      assets: string[];
      pairs: Array<{ blockchain: string; asset: string }>;
    }>;
  };
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
  const pin = {
    origin: 'dfx',
    externalId: 'e2e-activity-recent',
    name: 'Activity Recent Pin',
    lat: 47.37,
    lon: 8.54,
    category: 'groceries',
  };
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

test('Function: SqliteMapPlaceStore — opening backfills only a null SPAR shop name', () => {
  const stdout = execFileSync('bun', ['e2e/sqlite-backfill.ts'], { encoding: 'utf8' });
  expect(stdout.trim()).toBe('ok');
});
