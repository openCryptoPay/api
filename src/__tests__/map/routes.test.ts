import { describe, expect, it } from 'vitest';
import { publicFilterResponse, publicPlaceSupports } from '@/lib/map/filter-catalog';
import { npubEncode } from '@/lib/map/nostr-key';
import { normalizeMapPlace, type MapPlaceInput } from '@/lib/map/place';
import { MemoryMapPlaceStore, type MapPhotoFile } from '@/lib/map/store';
import { createApp } from '@/server';
import { keyFor } from './keys';
import { base64, simpleJpeg, simplePng } from './photo-fixtures';

const DESCRIPTION =
  'SPAR supermarket in Triesen. Customers can pay with Bitcoin and other crypto assets through OpenCryptoPay at the checkout.';

const OTHER_DESCRIPTION =
  'Neighbourhood grocery in Zürich. Customers can pay with Bitcoin and other crypto assets through OpenCryptoPay at the checkout.';

const body = {
  origin: 'dfx',
  externalId: 'store-1',
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
};

const publicPin = {
  origin: 'dfx',
  name: 'SPAR Triesen',
  description: DESCRIPTION,
  lat: 47.37,
  lon: 8.54,
  category: 'groceries',
  techProvider: 'DFX.swiss',
  shopType: 'SPAR',
  shopName: 'SPAR',
  country: 'LI',
  street: 'Maschlinastrasse',
  houseNumber: '4',
  postalCode: '9495',
  city: 'Triesen',
  supports: publicPlaceSupports('DFX.swiss'),
  activity: 'none',
  coverPhoto: null,
  googleMapsUrl: null,
};

const jsonHeaders = {
  Authorization: 'Bearer secret',
  'Content-Type': 'application/json',
};

type AppOptions = {
  token?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  store?: MemoryMapPlaceStore;
  now?: () => number;
};

function rawApp(opts: AppOptions) {
  return createApp({
    store: opts.store ?? new MemoryMapPlaceStore(),
    env: opts.env ?? {},
    fetchImpl: opts.fetchImpl ?? (async () => new Response('{}', { status: 201 })),
    publicBaseUrl: 'https://api.test',
    ...(opts.token === undefined ? {} : { ingestToken: opts.token }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
}

/** Adds a key derived from origin and external id to a POST or PUT pin body without one. */
function keyedBody(path: string, init?: RequestInit): RequestInit | undefined {
  if (
    path !== '/map/places' ||
    (init?.method !== 'POST' && init?.method !== 'PUT') ||
    typeof init.body !== 'string'
  ) {
    return init;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return init;
  }
  const rec = parsed as Record<string, unknown>;
  if ('nostrPubkey' in rec || typeof rec['origin'] !== 'string') {
    return init;
  }
  const key = keyFor(`${rec['origin']}\n${String(rec['externalId'])}`);
  return { ...init, body: JSON.stringify({ ...rec, nostrPubkey: key }) };
}

/** The app, with keys added to pin writes so tests about other fields need not send one. */
function app(opts: AppOptions) {
  const api = rawApp(opts);
  return {
    request: (path: string, init?: RequestInit) => api.request(path, keyedBody(path, init)),
  };
}

describe('map routes', () => {
  it('serves a welcome page and leaves unknown paths as 404', async () => {
    const api = app({});
    const page = await api.request('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type') ?? '').toContain('text/html');
    const html = await page.text();
    expect(html).toContain('<h1>Welcome</h1>');
    expect(html).toContain('href="/map/places"');
    expect(html).toContain('href="/map/filters"');
    expect(html).toContain('href="/healthz"');
    expect(html).toContain('https://opencryptopay.io');
    expect((await api.request('/no-such')).status).toBe(404);
    expect((await api.request('/', { method: 'POST' })).status).toBe(404);
  });

  it('serves health and an empty public list', async () => {
    const api = app({});
    expect((await api.request('/healthz')).status).toBe(200);
    const list = await api.request('/map/places');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ places: [] });
    const one = await api.request('/map/places?limit=1');
    expect(one.status).toBe(200);
    const filters = await api.request('/map/filters');
    expect(filters.status).toBe(200);
    expect(await filters.json()).toEqual(
      publicFilterResponse({ countries: [], blockchains: [], assets: [] }),
    );
  });

  it('filters GET /map/places by origin and rejects SPAR', async () => {
    const api = app({ token: 'secret' });
    const dfx = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
    expect(dfx.status).toBe(201);
    const spar = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        ...body,
        origin: 'spar',
        externalId: 'spar-1',
        name: 'SPAR Shop',
      }),
    });
    expect(spar.status).toBe(201);
    const filtered = await api.request('/map/places?origin=spar');
    expect(filtered.status).toBe(200);
    const filteredJson = (await filtered.json()) as {
      places: Array<{ origin: string; name: string }>;
    };
    expect(filteredJson.places).toHaveLength(1);
    expect(filteredJson.places[0]?.origin).toBe('spar');
    expect(filteredJson.places[0]?.name).toBe('SPAR Shop');
    const bad = await api.request('/map/places?origin=SPAR');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Place origin is invalid' });
    const all = (await (await api.request('/map/places')).json()) as {
      places: Array<{ origin: string }>;
    };
    expect(all.places).toHaveLength(2);
    expect(all.places.map((row) => row.origin).sort()).toEqual(['dfx', 'spar']);
  });

  it('accepts origin 21gifts on PUT and GET and rejects a leading hyphen or uppercase', async () => {
    const api = app({ token: 'secret' });
    const created = await api.request('/map/places', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({
        origin: '21gifts',
        externalId: 'shop-1',
        name: 'Shop',
        description: OTHER_DESCRIPTION,
        lat: 14.620311,
        lon: 120.959626,
        category: 'shopping',
        paymentMethods: 'lightning',
        techProvider: '21.gifts',
        shopType: 'Others',
        street: 'Santa Bakhita',
        houseNumber: '1',
        postalCode: '1011',
        city: 'Manila',
        country: 'PH',
      }),
    });
    expect(created.status).toBe(201);
    const createdJson = (await created.json()) as { created: boolean };
    expect(createdJson.created).toBe(true);
    const listed = await api.request('/map/places?origin=21gifts');
    expect(listed.status).toBe(200);
    const listedJson = (await listed.json()) as {
      places: Array<{
        origin: string;
        name: string;
        category: string;
        techProvider: string;
        shopType: string;
        shopName: string | null;
      }>;
    };
    expect(listedJson.places).toHaveLength(1);
    expect(listedJson.places[0]?.origin).toBe('21gifts');
    expect(listedJson.places[0]?.name).toBe('Shop');
    expect(listedJson.places[0]?.category).toBe('shopping');
    expect(listedJson.places[0]?.techProvider).toBe('21.gifts');
    expect(listedJson.places[0]?.shopType).toBe('Others');
    expect(listedJson.places[0]?.shopName).toBeNull();
    const hyphen = await api.request('/map/places?origin=-21gifts');
    expect(hyphen.status).toBe(400);
    expect(await hyphen.json()).toEqual({ error: 'Place origin is invalid' });
    const uppercase = await api.request('/map/places?origin=21Gifts');
    expect(uppercase.status).toBe(400);
    expect(await uppercase.json()).toEqual({ error: 'Place origin is invalid' });
    const putHyphen = await api.request('/map/places', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({
        origin: '-21gifts',
        externalId: 'shop-2',
        name: 'Shop',
        description: OTHER_DESCRIPTION,
        lat: 14.620311,
        lon: 120.959626,
        category: 'shopping',
        paymentMethods: 'lightning',
        techProvider: '21.gifts',
        shopType: 'Others',
        street: 'Santa Bakhita',
        houseNumber: '1',
        postalCode: '1011',
        city: 'Manila',
        country: 'PH',
      }),
    });
    expect(putHyphen.status).toBe(400);
    expect(await putHyphen.json()).toEqual({ error: 'Place origin is invalid' });
  });

  it('rejects a bad limit', async () => {
    const api = app({});
    expect((await api.request('/map/places?limit=0')).status).toBe(400);
    expect((await api.request('/map/places?limit=1001')).status).toBe(400);
    expect((await api.request('/map/places?limit=no')).status).toBe(400);
  });

  it('refuses ingest until a token is configured', async () => {
    const missing = await app({}).request('/map/places', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(missing.status).toBe(503);
    const blank = await app({ token: '  ' }).request('/map/places', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify(body),
    });
    expect(blank.status).toBe(503);
    const putMissing = await app({}).request('/map/places', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    expect(putMissing.status).toBe(503);
    expect(await putMissing.json()).toEqual({ error: 'Place ingest is not configured' });
    const putBlank = await app({ token: '  ' }).request('/map/places', {
      method: 'PUT',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify(body),
    });
    expect(putBlank.status).toBe(503);
    const deleteMissing = await app({}).request('/map/places', {
      method: 'DELETE',
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-1' }),
    });
    expect(deleteMissing.status).toBe(503);
    const deleteBlank = await app({ token: '  ' }).request('/map/places', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-1' }),
    });
    expect(deleteBlank.status).toBe(503);
  });

  it('rejects a missing, short, or wrong bearer and a bad body', async () => {
    const api = app({ token: 'secret' });
    const noHeader = await api.request('/map/places', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(noHeader.status).toBe(401);
    const short = await api.request('/map/places', {
      method: 'POST',
      headers: { Authorization: 'Bearer x' },
      body: JSON.stringify(body),
    });
    expect(short.status).toBe(401);
    const wrong = await api.request('/map/places', {
      method: 'POST',
      headers: { Authorization: 'Bearer secreX' },
      body: JSON.stringify(body),
    });
    expect(wrong.status).toBe(401);
    const bad = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: '{',
    });
    expect(bad.status).toBe(400);
    const putNoHeader = await api.request('/map/places', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    expect(putNoHeader.status).toBe(401);
    expect(await putNoHeader.json()).toEqual({ error: 'Unauthorized' });
    const putWrong = await api.request('/map/places', {
      method: 'PUT',
      headers: { Authorization: 'Bearer secreX' },
      body: JSON.stringify(body),
    });
    expect(putWrong.status).toBe(401);
    const putBad = await api.request('/map/places', {
      method: 'PUT',
      headers: jsonHeaders,
      body: '{',
    });
    expect(putBad.status).toBe(400);
    const putInvalidTech = await api.request('/map/places', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, techProvider: 'bad provider' }),
    });
    expect(putInvalidTech.status).toBe(400);
    expect(await putInvalidTech.json()).toEqual({ error: 'Place tech provider is invalid' });
    const unknownKey = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, shopName: 'SPAR' }),
    });
    expect(unknownKey.status).toBe(400);
    expect(await unknownKey.json()).toEqual({ error: 'Place field is not allowed: shopName' });
    const longKey = 'k'.repeat(60);
    const longUnknown = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, [longKey]: 1 }),
    });
    expect(longUnknown.status).toBe(400);
    expect(await longUnknown.json()).toEqual({
      error: `Place field is not allowed: ${'k'.repeat(40)}`,
    });
    const deleteNoHeader = await api.request('/map/places', {
      method: 'DELETE',
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-1' }),
    });
    expect(deleteNoHeader.status).toBe(401);
    const deleteWrong = await api.request('/map/places', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer secreX' },
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-1' }),
    });
    expect(deleteWrong.status).toBe(401);
    const deleteBad = await api.request('/map/places', {
      method: 'DELETE',
      headers: jsonHeaders,
      body: '{',
    });
    expect(deleteBad.status).toBe(400);
  });

  it('stores a pin once and pushes only the first time', async () => {
    const calls: string[] = [];
    const api = app({
      token: 'secret',
      env: { BTCMAP_ACCESS_TOKEN: 'map-token' },
      fetchImpl: async (input) => {
        calls.push(input);
        return new Response('{}', { status: 201 });
      },
    });
    const created = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { created: boolean; id: string; btcmap: string };
    expect(createdBody.btcmap).toBe('sent');
    const again = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, name: 'Other', techProvider: '21.gifts' }),
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      created: false,
      id: createdBody.id,
      btcmap: 'skipped',
    });
    expect(calls).toHaveLength(1);
    const list = (await (await api.request('/map/places')).json()) as {
      places: Array<Record<string, unknown>>;
    };
    expect(list.places[0]).toEqual({
      id: createdBody.id,
      ...publicPin,
    });
  });

  it('upserts on PUT as a full replace and pushes BTC Map only when created', async () => {
    const calls: string[] = [];
    const api = app({
      token: 'secret',
      env: { BTCMAP_ACCESS_TOKEN: 'map-token' },
      fetchImpl: async (input) => {
        calls.push(input);
        return new Response('{}', { status: 201 });
      },
    });
    const created = await api.request('/map/places', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, techProvider: '21.gifts' }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { created: boolean; id: string; btcmap: string };
    expect(createdBody).toEqual({ created: true, id: createdBody.id, btcmap: 'sent' });
    expect(calls).toHaveLength(1);
    const updated = await api.request('/map/places', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({
        ...body,
        name: 'Other Shop',
        description: OTHER_DESCRIPTION,
        shopType: 'Others',
        street: 'Bahnhofstrasse',
        houseNumber: '12',
        postalCode: '8001',
        city: 'Zürich',
        country: 'CH',
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      created: false,
      id: createdBody.id,
      btcmap: 'skipped',
    });
    expect(calls).toHaveLength(1);
    const list = (await (await api.request('/map/places')).json()) as {
      places: Array<Record<string, unknown>>;
    };
    expect(list.places[0]).toEqual({
      id: createdBody.id,
      origin: 'dfx',
      name: 'Other Shop',
      description: OTHER_DESCRIPTION,
      lat: 47.37,
      lon: 8.54,
      category: 'groceries',
      techProvider: 'DFX.swiss',
      shopType: 'Others',
      shopName: null,
      country: 'CH',
      street: 'Bahnhofstrasse',
      houseNumber: '12',
      postalCode: '8001',
      city: 'Zürich',
      supports: publicPlaceSupports('DFX.swiss'),
      activity: 'none',
      coverPhoto: null,
      googleMapsUrl: null,
    });
  });

  it('rejects a PUT that omits a required field and does not replace the stored pin', async () => {
    const api = app({ token: 'secret' });
    const created = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        ...body,
        supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string };
    const listed = (await (await api.request('/map/places')).json()) as {
      places: Array<Record<string, unknown>>;
    };
    expect(listed.places[0]).toEqual({
      id: createdBody.id,
      ...publicPin,
    });
    const omittedCountry = await api.request('/map/places', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({
        origin: 'dfx',
        externalId: 'store-1',
        name: 'Renamed',
        description: OTHER_DESCRIPTION,
        lat: 47.37,
        lon: 8.54,
        category: 'groceries',
        shopType: 'SPAR',
        street: 'Limmatquai',
        houseNumber: '4',
        postalCode: '8001',
        city: 'Zürich',
      }),
    });
    expect(omittedCountry.status).toBe(400);
    expect(await omittedCountry.json()).toEqual({ error: 'Place country is invalid' });
    const badStreet = await api.request('/map/places', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, street: '  ' }),
    });
    expect(badStreet.status).toBe(400);
    expect(await badStreet.json()).toEqual({ error: 'Place street is invalid' });
    const badHouse = await api.request('/map/places', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, houseNumber: 1 }),
    });
    expect(badHouse.status).toBe(400);
    expect(await badHouse.json()).toEqual({ error: 'Place house number is invalid' });
    const badPostal = await api.request('/map/places', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, postalCode: '' }),
    });
    expect(badPostal.status).toBe(400);
    expect(await badPostal.json()).toEqual({ error: 'Place postal code is invalid' });
    const badCity = await api.request('/map/places', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, city: 'bad\ncity' }),
    });
    expect(badCity.status).toBe(400);
    expect(await badCity.json()).toEqual({ error: 'Place city is invalid' });
    const after = (await (await api.request('/map/places')).json()) as {
      places: Array<Record<string, unknown>>;
    };
    expect(after.places[0]).toEqual({
      id: createdBody.id,
      ...publicPin,
    });
    const again = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        ...body,
        street: 'Other Street',
        houseNumber: '99',
        postalCode: '10115',
        city: 'Berlin',
        country: 'DE',
      }),
    });
    expect(again.status).toBe(200);
    const afterInsert = (await (await api.request('/map/places')).json()) as {
      places: Array<Record<string, unknown>>;
    };
    expect(afterInsert.places[0]).toEqual({
      id: createdBody.id,
      ...publicPin,
    });
  });

  it('clears supports on PUT when the body omits them', async () => {
    const api = app({ token: 'secret' });
    const created = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        ...body,
        supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string };
    const updated = await api.request('/map/places', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
    expect(updated.status).toBe(200);
    const listed = (await (await api.request('/map/places')).json()) as {
      places: Array<Record<string, unknown>>;
    };
    expect(listed.places[0]).toEqual({
      id: createdBody.id,
      ...publicPin,
      supports: publicPlaceSupports('DFX.swiss'),
    });
  });

  it('deletes a pin without calling BTC Map and is idempotent', async () => {
    const calls: string[] = [];
    const api = app({
      token: 'secret',
      env: { BTCMAP_ACCESS_TOKEN: 'map-token' },
      fetchImpl: async (input) => {
        calls.push(input);
        return new Response('{}', { status: 201 });
      },
    });
    const created = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(201);
    expect(calls).toHaveLength(1);
    const deleted = await api.request('/map/places', {
      method: 'DELETE',
      headers: jsonHeaders,
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-1' }),
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(calls).toHaveLength(1);
    const listed = (await (await api.request('/map/places')).json()) as { places: unknown[] };
    expect(listed.places).toEqual([]);
    const missing = await api.request('/map/places', {
      method: 'DELETE',
      headers: jsonHeaders,
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-1' }),
    });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ deleted: false });
    const extra = await api.request('/map/places', {
      method: 'DELETE',
      headers: jsonHeaders,
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-1', name: 'ignored' }),
    });
    expect(extra.status).toBe(400);
    expect(await extra.json()).toEqual({ error: 'Place field is not allowed: name' });
    expect(calls).toHaveLength(1);
  });

  it('rejects id on PUT and POST and inserts nothing', async () => {
    const api = app({ token: 'secret' });
    const posted = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, id: 'pin-1' }),
    });
    expect(posted.status).toBe(400);
    expect(await posted.json()).toEqual({ error: 'Place field is not allowed: id' });
    const put = await api.request('/map/places', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, id: 'pin-1' }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error: 'Place field is not allowed: id' });
    const list = (await (await api.request('/map/places')).json()) as { places: unknown[] };
    expect(list.places).toEqual([]);
  });

  it('rejects id on DELETE and deletes nothing', async () => {
    const api = app({ token: 'secret' });
    const created = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(201);
    const deleted = await api.request('/map/places', {
      method: 'DELETE',
      headers: jsonHeaders,
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-1', id: 'pin-1' }),
    });
    expect(deleted.status).toBe(400);
    expect(await deleted.json()).toEqual({ error: 'Place field is not allowed: id' });
    const onlyId = await api.request('/map/places', {
      method: 'DELETE',
      headers: jsonHeaders,
      body: JSON.stringify({ id: null }),
    });
    expect(onlyId.status).toBe(400);
    expect(await onlyId.json()).toEqual({ error: 'Place field is not allowed: id' });
    const list = (await (await api.request('/map/places')).json()) as { places: unknown[] };
    expect(list.places).toHaveLength(1);
  });

  it('hides the caller id and payment methods on the public list', async () => {
    const api = app({ token: 'secret' });
    const created = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string };
    const list = (await (await api.request('/map/places')).json()) as {
      places: Array<Record<string, unknown>>;
    };
    expect(list.places).toHaveLength(1);
    expect(list.places[0]).not.toHaveProperty('externalId');
    expect(list.places[0]).not.toHaveProperty('paymentMethods');
    expect(list.places[0]).toEqual({ id: createdBody.id, ...publicPin });
  });

  it('filters GET /map/places by shop type, shop name alias, country, blockchain, and asset', async () => {
    const api = app({ token: 'secret' });
    const match = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        ...body,
        externalId: 'match',
        country: 'CH',
        postalCode: '8001',
        shopType: 'SPAR',
        supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
      }),
    });
    expect(match.status).toBe(201);
    const other = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        ...body,
        externalId: 'other',
        name: 'Other Shop',
        description: OTHER_DESCRIPTION,
        country: 'DE',
        postalCode: '10115',
        shopType: 'Others',
        supports: [
          { blockchain: 'Polygon', asset: 'ZCHF' },
          { blockchain: 'Ethereum', asset: 'ETH' },
        ],
      }),
    });
    expect(other.status).toBe(201);
    const filtered = await api.request(
      '/map/places?shopType=SPAR&country=CH&blockchain=Ethereum&asset=ZCHF',
    );
    expect(filtered.status).toBe(200);
    const filteredJson = (await filtered.json()) as {
      places: Array<{ name: string; country: string; shopType: string; shopName: string | null }>;
    };
    expect(filteredJson.places).toHaveLength(1);
    expect(filteredJson.places[0]?.shopType).toBe('SPAR');
    expect(filteredJson.places[0]?.shopName).toBe('SPAR');
    expect(filteredJson.places[0]?.country).toBe('CH');
    const alias = await api.request('/map/places?shopName=others');
    const aliasJson = (await alias.json()) as {
      places: Array<{ shopType: string; shopName: string | null }>;
    };
    expect(aliasJson.places).toHaveLength(1);
    expect(aliasJson.places[0]?.shopType).toBe('Others');
    expect(aliasJson.places[0]?.shopName).toBeNull();
    expect((await api.request('/map/places?shopName=Migros')).status).toBe(400);
    expect(await (await api.request('/map/places?shopName=Migros')).json()).toEqual({
      error: 'Place shop name is invalid',
    });
    expect((await api.request('/map/places?shopType=others')).status).toBe(400);
    expect(await (await api.request('/map/places?shopType=others')).json()).toEqual({
      error: 'Place shop type is invalid',
    });
    expect((await api.request('/map/places?shopType=SPAR&shopName=others')).status).toBe(400);
    expect(await (await api.request('/map/places?shopType=SPAR&shopName=others')).json()).toEqual({
      error: 'Place shop type is invalid',
    });
    expect((await api.request('/map/places?country=ZZ')).status).toBe(400);
    expect(await (await api.request('/map/places?country=ZZ')).json()).toEqual({
      error: 'Place country is invalid',
    });
    expect((await api.request('/map/places?country=CHE')).status).toBe(400);
    expect(await (await api.request('/map/places?country=CHE')).json()).toEqual({
      error: 'Place country is invalid',
    });
    expect((await api.request('/map/places?country=PH')).status).toBe(200);
    expect((await api.request('/map/places?blockchain=ethereum')).status).toBe(400);
    expect(await (await api.request('/map/places?blockchain=ethereum')).json()).toEqual({
      error: 'Place support is invalid',
    });
    expect((await api.request('/map/places?blockchain=Frick')).status).toBe(400);
    expect(await (await api.request('/map/places?blockchain=Frick')).json()).toEqual({
      error: 'Place support is invalid',
    });
    expect((await api.request('/map/places?asset=zchf')).status).toBe(400);
    expect(await (await api.request('/map/places?asset=zchf')).json()).toEqual({
      error: 'Place support is invalid',
    });
    expect((await api.request('/map/places?asset=Ethereum/ZCHF')).status).toBe(400);
    expect(await (await api.request('/map/places?asset=Ethereum/ZCHF')).json()).toEqual({
      error: 'Place support is invalid',
    });
  });

  it('lists a DFX.swiss pin for a catalog pair even when stored rows differ', async () => {
    const api = app({ token: 'secret' });
    const created = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        ...body,
        externalId: 'split-pair',
        supports: [
          { blockchain: 'Polygon', asset: 'ZCHF' },
          { blockchain: 'Ethereum', asset: 'ETH' },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const mismatch = await api.request('/map/places?blockchain=Ethereum&asset=ZCHF');
    expect(mismatch.status).toBe(200);
    const mismatchJson = (await mismatch.json()) as { places: unknown[] };
    expect(mismatchJson.places).toHaveLength(1);
    const eth = await api.request('/map/places?blockchain=Ethereum&asset=ETH');
    expect(eth.status).toBe(200);
    const ethJson = (await eth.json()) as { places: Array<{ name: string }> };
    expect(ethJson.places).toHaveLength(1);
    expect(ethJson.places[0]?.name).toBe(body.name);
    const polygon = await api.request('/map/places?blockchain=Polygon&asset=ZCHF');
    expect(polygon.status).toBe(200);
    const polygonJson = (await polygon.json()) as { places: unknown[] };
    expect(polygonJson.places).toHaveLength(1);
  });

  it('returns a stored dEURO asset unchanged', async () => {
    const api = app({ token: 'secret' });
    const created = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        ...body,
        externalId: 'deuro',
        supports: [{ blockchain: 'Ethereum', asset: 'dEURO' }],
      }),
    });
    expect(created.status).toBe(201);
    const listed = await api.request('/map/places?asset=dEURO');
    expect(listed.status).toBe(200);
    const json = (await listed.json()) as {
      places: Array<{ supports: Array<{ blockchain: string; asset: string }> }>;
    };
    expect(json.places).toHaveLength(1);
    expect(json.places[0]?.supports).toEqual(publicPlaceSupports('DFX.swiss'));
  });

  it('returns GET /map/filters from stored rows and rejects a bad blockchain', async () => {
    const api = app({ token: 'secret' });
    const created = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        ...body,
        country: 'CH',
        postalCode: '8001',
        shopType: 'SPAR',
        supports: [
          { blockchain: 'Ethereum', asset: 'ZCHF' },
          { blockchain: 'Polygon', asset: 'ETH' },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const filters = await api.request('/map/filters');
    expect(filters.status).toBe(200);
    const filterJson = (await filters.json()) as {
      shopTypes: string[];
      shopNames: string[];
      countries: string[];
      blockchains: string[];
      assets: string[];
    };
    expect(filterJson.shopTypes).toEqual(['SPAR', 'Others']);
    expect(filterJson.shopNames).toEqual(['SPAR', 'others']);
    expect(filterJson).toEqual(
      publicFilterResponse({
        countries: ['CH'],
        blockchains: ['Ethereum', 'Polygon'],
        assets: ['ETH', 'ZCHF'],
      }),
    );
    const ethereum = await api.request('/map/filters?blockchain=Ethereum');
    expect(ethereum.status).toBe(200);
    expect(await ethereum.json()).toEqual(
      publicFilterResponse(
        {
          countries: ['CH'],
          blockchains: ['Ethereum', 'Polygon'],
          assets: ['ZCHF'],
        },
        'Ethereum',
      ),
    );
    const bad = await api.request('/map/filters?blockchain=ethereum');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Place support is invalid' });
  });

  it('refuses place transactions until a token is configured', async () => {
    const tx = { origin: 'dfx', externalId: 'store-1' };
    const missing = await app({}).request('/map/places/transactions', {
      method: 'POST',
      body: JSON.stringify(tx),
    });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: 'Place ingest is not configured' });
    const blank = await app({ token: '  ' }).request('/map/places/transactions', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify(tx),
    });
    expect(blank.status).toBe(503);
    expect(await blank.json()).toEqual({ error: 'Place ingest is not configured' });
  });

  it('rejects a missing or wrong bearer for place transactions', async () => {
    const api = app({ token: 'secret' });
    const tx = { origin: 'dfx', externalId: 'store-1' };
    const noHeader = await api.request('/map/places/transactions', {
      method: 'POST',
      body: JSON.stringify(tx),
    });
    expect(noHeader.status).toBe(401);
    expect(await noHeader.json()).toEqual({ error: 'Unauthorized' });
    const wrong = await api.request('/map/places/transactions', {
      method: 'POST',
      headers: { Authorization: 'Bearer secreX' },
      body: JSON.stringify(tx),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'Unauthorized' });
  });

  it('rejects invalid JSON, a bad origin, and a future occurredAt', async () => {
    const api = app({ token: 'secret' });
    const badJson = await api.request('/map/places/transactions', {
      method: 'POST',
      headers: jsonHeaders,
      body: '{',
    });
    expect(badJson.status).toBe(400);
    const badOrigin = await api.request('/map/places/transactions', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ origin: 'DFX', externalId: 'store-1' }),
    });
    expect(badOrigin.status).toBe(400);
    expect(await badOrigin.json()).toEqual({ error: 'Place origin is invalid' });
    const future = await api.request('/map/places/transactions', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        origin: 'dfx',
        externalId: 'store-1',
        occurredAt: new Date(Date.now() + 3 * 60 * 1000).toISOString(),
      }),
    });
    expect(future.status).toBe(400);
    expect(await future.json()).toEqual({ error: 'Place transaction time is invalid' });
  });

  it('returns 404 for an unknown pair and does not call fetchImpl', async () => {
    const calls: string[] = [];
    const api = app({
      token: 'secret',
      env: { BTCMAP_ACCESS_TOKEN: 'map-token' },
      fetchImpl: async (input) => {
        calls.push(input);
        return new Response('{}', { status: 201 });
      },
    });
    const missing = await api.request('/map/places/transactions', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-1' }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Place not found' });
    expect(calls).toHaveLength(0);
  });

  it('records a transaction and classifies activity at the request clock', async () => {
    const store = new MemoryMapPlaceStore();
    const calls: string[] = [];
    const api = app({
      token: 'secret',
      store,
      env: { BTCMAP_ACCESS_TOKEN: 'map-token' },
      fetchImpl: async (input) => {
        calls.push(input);
        return new Response('{}', { status: 201 });
      },
    });
    const created = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(201);
    expect(calls).toHaveLength(1);
    const omitted = await api.request('/map/places/transactions', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-1' }),
    });
    expect(omitted.status).toBe(200);
    expect(await omitted.json()).toEqual({ activity: 'within7Days' });
    expect(calls).toHaveLength(1);
    const listed = (await (await api.request('/map/places')).json()) as {
      places: Array<{ activity: string; externalId?: string }>;
    };
    expect(listed.places[0]?.activity).toBe('within7Days');
    const oldIso = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const older = await api.request('/map/places/transactions', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-1', occurredAt: oldIso }),
    });
    expect(older.status).toBe(200);
    expect(await older.json()).toEqual({ activity: 'within7Days' });
    expect(store.list(1)[0]?.lastTransactionAt).not.toBe(oldIso);
    const afterOlder = (await (await api.request('/map/places')).json()) as {
      places: Array<{ activity: string }>;
    };
    expect(afterOlder.places[0]?.activity).toBe('within7Days');
    const other = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, externalId: 'store-old', name: 'Store Old' }),
    });
    expect(other.status).toBe(201);
    const noneRes = await api.request('/map/places/transactions', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-old', occurredAt: oldIso }),
    });
    expect(noneRes.status).toBe(200);
    expect(await noneRes.json()).toEqual({ activity: 'olderThan30Days' });
    expect(store.list(10).find((row) => row.externalId === 'store-old')?.lastTransactionAt).toBe(
      oldIso,
    );
    expect(calls).toHaveLength(2);
  });

  it('classifies activity from the injected clock', async () => {
    const nowMs = Date.parse('2026-10-08T00:00:00.000Z');
    const api = app({ token: 'secret', now: () => nowMs });
    const created = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, externalId: 'ten-days', name: 'Ten Days' }),
    });
    expect(created.status).toBe(201);
    const tenDays = new Date(nowMs - 10 * 24 * 60 * 60 * 1000).toISOString();
    const older = await api.request('/map/places/transactions', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ origin: 'dfx', externalId: 'ten-days', occurredAt: tenDays }),
    });
    expect(older.status).toBe(200);
    expect(await older.json()).toEqual({ activity: 'within30Days' });
    const listed = (await (await api.request('/map/places')).json()) as {
      places: Array<{ name: string; activity: string }>;
    };
    expect(listed.places.find((row) => row.name === 'Ten Days')?.activity).toBe('within30Days');
    const seven = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, externalId: 'seven-days', name: 'Seven Days' }),
    });
    expect(seven.status).toBe(201);
    const sevenDays = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recent = await api.request('/map/places/transactions', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ origin: 'dfx', externalId: 'seven-days', occurredAt: sevenDays }),
    });
    expect(recent.status).toBe(200);
    expect(await recent.json()).toEqual({ activity: 'within7Days' });
  });

  it('copies stored activity on GET until refreshActivity runs at the new clock', async () => {
    const startMs = Date.parse('2026-10-08T00:00:00.000Z');
    let clock = startMs;
    const store = new MemoryMapPlaceStore(() => new Date(startMs));
    const api = app({ token: 'secret', store, now: () => clock });
    const created = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ...body, externalId: 'stale-clock', name: 'Stale Clock' }),
    });
    expect(created.status).toBe(201);
    const sevenDays = new Date(startMs - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recorded = await api.request('/map/places/transactions', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ origin: 'dfx', externalId: 'stale-clock', occurredAt: sevenDays }),
    });
    expect(recorded.status).toBe(200);
    expect(await recorded.json()).toEqual({ activity: 'within7Days' });
    clock = startMs + 1;
    const listed = (await (await api.request('/map/places')).json()) as {
      places: Array<{ name: string; activity: string }>;
    };
    expect(listed.places.find((row) => row.name === 'Stale Clock')?.activity).toBe('within7Days');
    store.refreshActivity(clock);
    const after = (await (await api.request('/map/places')).json()) as {
      places: Array<{ name: string; activity: string }>;
    };
    expect(after.places.find((row) => row.name === 'Stale Clock')?.activity).toBe('within30Days');
  });
});

describe('map routes NOSTR identity and request order', () => {
  const keyA = keyFor('route-a');
  const keyB = keyFor('route-b');
  const npubA = npubEncode(keyA);

  function send(api: ReturnType<typeof rawApp>, method: string, payload: unknown) {
    return api.request('/map/places', {
      method,
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    });
  }

  it('rejects a place without a key with 400 and stores nothing (step 1b)', async () => {
    const store = new MemoryMapPlaceStore();
    const api = rawApp({ token: 'secret', store });
    for (const method of ['POST', 'PUT'] as const) {
      const refused = await send(api, method, body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'Place NOSTR public key is required' });
    }
    expect(store.listAll()).toEqual([]);
  });

  it('adds the key to a row stored before step 1a and lists it with its npub', async () => {
    const store = new MemoryMapPlaceStore();
    const parsed = normalizeMapPlace({ ...body, nostrPubkey: keyA });
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const keyless: MapPlaceInput = { ...parsed.value };
    delete keyless.nostrPubkey;
    store.insertIfNew(keyless);
    const api = rawApp({ token: 'secret', store });
    const added = await send(api, 'POST', { ...body, nostrPubkey: keyA });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ created: false, id: npubA });
    const replaced = await send(api, 'PUT', {
      ...body,
      nostrPubkey: keyA,
      name: 'SPAR Triesen Nord',
    });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ created: false, id: npubA });
    const listed = (await (await api.request('/map/places')).json()) as {
      places: Array<{ id: string; name: string }>;
    };
    expect(listed.places).toEqual([
      expect.objectContaining({ id: npubA, name: 'SPAR Triesen Nord' }),
    ]);
  });

  it('answers 409 for a changed key and for a key of another place', async () => {
    const api = rawApp({ token: 'secret' });
    await send(api, 'PUT', { ...body, nostrPubkey: keyA });
    const changed = await send(api, 'PUT', { ...body, nostrPubkey: keyB });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: 'nostrPubkey of a place cannot change' });
    const taken = await send(api, 'POST', { ...body, externalId: 'store-2', nostrPubkey: keyA });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: 'nostrPubkey belongs to another place' });
  });

  it('answers 409 for a second shop with the same name and keeps a put of the own name', async () => {
    const api = rawApp({ token: 'secret' });
    const first = await send(api, 'POST', {
      ...body,
      name: 'Shared Shop',
      nostrPubkey: keyA,
    });
    expect(first.status).toBe(201);
    const second = await send(api, 'POST', {
      ...body,
      externalId: 'store-2',
      name: 'Shared Shop',
      nostrPubkey: keyB,
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'Place name belongs to another place' });
    const kept = await send(api, 'PUT', { ...body, name: 'Shared Shop', nostrPubkey: keyA });
    expect(kept.status).toBe(200);
    const listed = (await (await api.request('/map/places')).json()) as {
      places: Array<{ name: string }>;
    };
    expect(listed.places.filter((row) => row.name === 'Shared Shop')).toHaveLength(1);
  });

  it('answers 400 for an invalid key or revision before any 409', async () => {
    const api = rawApp({ token: 'secret' });
    await send(api, 'PUT', { ...body, nostrPubkey: keyA, revision: 5 });
    const badKey = await send(api, 'PUT', { ...body, nostrPubkey: 'zz', revision: 1 });
    expect(badKey.status).toBe(400);
    expect(await badKey.json()).toEqual({ error: 'Place NOSTR public key is invalid' });
    const badRevision = await send(api, 'POST', { ...body, nostrPubkey: keyA, revision: '6' });
    expect(badRevision.status).toBe(400);
    expect(await badRevision.json()).toEqual({ error: 'Place revision is invalid' });
    const badDelete = await send(api, 'DELETE', {
      origin: 'dfx',
      externalId: 'store-1',
      revision: 0,
    });
    expect(badDelete.status).toBe(400);
  });

  it('refuses a stale revision on POST, PUT and DELETE and keeps it after delete', async () => {
    const api = rawApp({ token: 'secret' });
    await send(api, 'PUT', { ...body, nostrPubkey: keyA, revision: 2 });
    for (const [method, payload] of [
      ['POST', { ...body, nostrPubkey: keyA, revision: 2 }],
      ['PUT', { ...body, nostrPubkey: keyA }],
      ['PUT', { ...body, nostrPubkey: keyB, revision: 1 }],
      ['DELETE', { origin: 'dfx', externalId: 'store-1', revision: 2 }],
      ['DELETE', { origin: 'dfx', externalId: 'store-1' }],
    ] as const) {
      const stale = await send(api, method, payload);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: 'Stale revision' });
    }
    const removed = await send(api, 'DELETE', {
      origin: 'dfx',
      externalId: 'store-1',
      revision: 3,
    });
    expect(await removed.json()).toEqual({ deleted: true });
    const late = await send(api, 'PUT', { ...body, nostrPubkey: keyA, revision: 3 });
    expect(late.status).toBe(409);
    const fresh = await send(api, 'PUT', { ...body, nostrPubkey: keyA, revision: 4 });
    expect(fresh.status).toBe(201);
  });

  it('serves a listed shop by npub, redirects its hex and caches both', async () => {
    const api = rawApp({ token: 'secret' });
    await send(api, 'PUT', { ...body, nostrPubkey: keyA });
    const detail = await api.request(`/map/places/${npubA}`);
    expect(detail.status).toBe(200);
    expect(detail.headers.get('cache-control')).toBe('public, max-age=60');
    expect(detail.headers.get('access-control-allow-origin')).toBe('*');
    expect(await detail.json()).toEqual({ place: { ...publicPin, id: npubA, photos: [] } });
    const hex = await api.request(`/map/places/${keyA}`);
    expect(hex.status).toBe(301);
    expect(hex.headers.get('location')).toBe(`/map/places/${npubA}`);
    expect(hex.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('answers 404 for an unlisted shop, an unknown key and anything else', async () => {
    const api = rawApp({ token: 'secret' });
    await send(api, 'PUT', { ...body, name: '', nostrPubkey: keyA });
    for (const segment of [
      npubA,
      keyA,
      npubEncode(keyB),
      keyB.toUpperCase(),
      `${npubA.slice(0, -1)}${npubA.endsWith('q') ? 'p' : 'q'}`,
      'store-1',
    ]) {
      const missing = await api.request(`/map/places/${segment}`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get('cache-control')).toBe('public, max-age=60');
      expect(await missing.json()).toEqual({ error: 'Place not found' });
    }
  });

  it('answers 503 without caching when the store fails', async () => {
    class FailingStore extends MemoryMapPlaceStore {
      override findPublicByPubkey(): undefined {
        throw new Error('store down');
      }
    }
    const api = rawApp({ store: new FailingStore() });
    const failed = await api.request(`/map/places/${npubA}`);
    expect(failed.status).toBe(503);
    expect(failed.headers.get('cache-control')).toBe('no-store');
    expect(await failed.json()).toEqual({ error: 'Places are unavailable' });
  });
});

describe('map routes photos', () => {
  const key = keyFor('route-photos');
  const npub = npubEncode(key);
  const jpegBytes = simpleJpeg(2, 1);
  const pngBytes = simplePng(3, 2);

  function upload(api: ReturnType<typeof rawApp>, payload: unknown, headers = jsonHeaders) {
    return api.request('/map/places/photos', {
      method: 'PUT',
      headers,
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  }

  async function shop(listed = true) {
    const store = new MemoryMapPlaceStore();
    const api = rawApp({ token: 'secret', store });
    if (listed) {
      await api.request('/map/places', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ ...body, nostrPubkey: key, revision: 1 }),
      });
    } else {
      const parsed = normalizeMapPlace({ ...body, nostrPubkey: key });
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      store.insertIfNew({ ...parsed.value, name: '' }, 1);
    }
    return api;
  }

  it('answers 503 and 401 before reading the body, then 413 for a body above 15 MiB', async () => {
    expect((await upload(rawApp({}), {})).status).toBe(503);
    const api = await shop();
    const unauthorized = await upload(api, {}, { ...jsonHeaders, Authorization: 'Bearer wrong' });
    expect(unauthorized.status).toBe(401);
    const huge = await upload(api, 'x'.repeat(15 * 1_048_576 + 1));
    expect(huge.status).toBe(413);
    expect(await huge.json()).toEqual({ error: 'Payload too large' });
  });

  it('answers 400 for a malformed envelope, 404 for another origin or key, then 409 for a stale revision', async () => {
    const api = await shop();
    const bad = await upload(api, 'not json');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Photo upload is invalid' });
    const other = await upload(api, { origin: 'spar', nostrPubkey: key, revision: 2, photos: [] });
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: 'Place not found' });
    const stale = await upload(api, { origin: 'dfx', nostrPubkey: key, revision: 1, photos: [] });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'Stale revision' });
  });

  it('stores the good photos, reports the skipped ones and shows them in the list and the detail', async () => {
    const api = await shop();
    const stored = await upload(api, {
      origin: 'dfx',
      nostrPubkey: key,
      revision: 2,
      photos: [
        { contentType: 'image/jpeg', data: base64(jpegBytes), caption: 'Front' },
        { contentType: 'image/gif', data: 'R0lG' },
        { contentType: 'image/png', data: base64(pngBytes) },
      ],
    });
    expect(stored.status).toBe(200);
    const result = (await stored.json()) as {
      photos: Array<{ url: string; width: number; height: number; caption: string | null }>;
      skipped: unknown[];
    };
    expect(result.skipped).toEqual([
      { index: 1, error: 'Photo 2 is not a JPEG, PNG or WebP image' },
    ]);
    expect(result.photos).toHaveLength(2);
    expect(result.photos[0]).toMatchObject({ width: 2, height: 1, caption: 'Front' });
    expect(result.photos[0]?.url).toMatch(/^https:\/\/api\.test\/map\/photos\/[0-9a-f]{64}\.jpg$/u);
    expect(result.photos[1]).toMatchObject({ width: 3, height: 2, caption: null });
    expect(result.photos[1]?.url).toMatch(/\.png$/u);
    const listed = (await (await api.request('/map/places')).json()) as {
      places: Array<{ coverPhoto: unknown }>;
    };
    expect(listed.places[0]?.coverPhoto).toEqual({
      url: result.photos[0]?.url,
      width: 2,
      height: 1,
    });
    const detail = (await (await api.request(`/map/places/${npub}`)).json()) as {
      place: { photos: unknown[] };
    };
    expect(detail.place.photos).toEqual(result.photos);
  });

  it('serves a photo of a listed shop with its type, nosniff and an immutable cache', async () => {
    const api = await shop();
    const stored = (await (
      await upload(api, {
        origin: 'dfx',
        nostrPubkey: key,
        revision: 2,
        photos: [{ contentType: 'image/png', data: base64(pngBytes) }],
      })
    ).json()) as { photos: Array<{ url: string }> };
    const path = new URL(stored.photos[0]?.url ?? '').pathname;
    const served = await api.request(path);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(served.headers.get('access-control-allow-origin')).toBe('*');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(pngBytes);
    for (const missing of [
      path.replace('.png', '.jpg'),
      '/map/photos/abc.png',
      `/map/photos/${'0'.repeat(64)}.png`,
    ]) {
      const res = await api.request(missing);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'Photo not found' });
    }
  });

  it('answers 404 for the photo of an unlisted shop and 503 when the store fails', async () => {
    const api = await shop(false);
    const stored = (await (
      await upload(api, {
        origin: 'dfx',
        nostrPubkey: key,
        photos: [{ contentType: 'image/png', data: base64(pngBytes) }],
        revision: 2,
      })
    ).json()) as { photos: Array<{ url: string }> };
    expect((await api.request(new URL(stored.photos[0]?.url ?? '').pathname)).status).toBe(404);
    class FailingStore extends MemoryMapPlaceStore {
      override findPublicPhoto(): undefined {
        throw new Error('store down');
      }
    }
    const failing = await rawApp({ store: new FailingStore() }).request(
      `/map/photos/${'0'.repeat(64)}.png`,
    );
    expect(failing.status).toBe(503);
    expect(failing.headers.get('cache-control')).toBe('no-store');
    expect(await failing.json()).toEqual({ error: 'Places are unavailable' });
  });

  it('serves only the bytes of a photo whose data is a view into a larger buffer', async () => {
    const pool = new Uint8Array(pngBytes.length + 16).fill(0xaa);
    pool.set(pngBytes, 8);
    // A Node Buffer, whose slice() is another view on the same pool, not a copy.
    const view = Buffer.from(pool.buffer, 8, pngBytes.length);
    class ViewStore extends MemoryMapPlaceStore {
      override findPublicPhoto(): MapPhotoFile {
        return { contentType: 'image/png', data: view };
      }
    }
    const served = await rawApp({ store: new ViewStore() }).request(
      `/map/photos/${'0'.repeat(64)}.png`,
    );
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(pngBytes);
  });
});
