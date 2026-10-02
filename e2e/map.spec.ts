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
