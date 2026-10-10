import { describe, expect, it } from 'vitest';
import { publicFilterResponse } from '@/lib/map/filter-catalog';
import { MemoryMapPlaceStore } from '@/lib/map/store';
import { createApp } from '@/server';

const body = {
  origin: 'dfx',
  externalId: 'store-1',
  name: 'SPAR',
  lat: 47.37,
  lon: 8.54,
  category: 'groceries',
  paymentMethods: 'lightning',
};

const jsonHeaders = {
  Authorization: 'Bearer secret',
  'Content-Type': 'application/json',
};

function app(opts: {
  token?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  store?: MemoryMapPlaceStore;
  now?: () => number;
}) {
  return createApp({
    store: opts.store ?? new MemoryMapPlaceStore(),
    env: opts.env ?? {},
    fetchImpl: opts.fetchImpl ?? (async () => new Response('{}', { status: 201 })),
    ...(opts.token === undefined ? {} : { ingestToken: opts.token }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
}

describe('map routes', () => {
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
        lat: 14.620311,
        lon: 120.959626,
        category: 'shopping',
        paymentMethods: 'lightning',
        techProvider: '21.gifts',
      }),
    });
    expect(created.status).toBe(201);
    const createdJson = (await created.json()) as { created: boolean };
    expect(createdJson.created).toBe(true);
    const listed = await api.request('/map/places?origin=21gifts');
    expect(listed.status).toBe(200);
    const listedJson = (await listed.json()) as {
      places: Array<{ origin: string; name: string; category: string; techProvider: string }>;
    };
    expect(listedJson.places).toHaveLength(1);
    expect(listedJson.places[0]?.origin).toBe('21gifts');
    expect(listedJson.places[0]?.name).toBe('Shop');
    expect(listedJson.places[0]?.category).toBe('shopping');
    expect(listedJson.places[0]?.techProvider).toBe('21.gifts');
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
        lat: 14.620311,
        lon: 120.959626,
        category: 'shopping',
        paymentMethods: 'lightning',
        techProvider: '21.gifts',
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
      origin: 'dfx',
      name: 'SPAR',
      lat: 47.37,
      lon: 8.54,
      category: 'groceries',
      techProvider: 'DFX.swiss',
      country: null,
      shopName: null,
      supports: [],
      activity: 'none',
    });
  });

  it('upserts on PUT and pushes BTC Map only when created', async () => {
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
      body: JSON.stringify({ ...body, name: 'Other' }),
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
      name: 'Other',
      lat: 47.37,
      lon: 8.54,
      category: 'groceries',
      techProvider: '21.gifts',
      country: null,
      shopName: null,
      supports: [],
      activity: 'none',
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
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-1', name: 'ignored' }),
    });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ deleted: false });
    expect(calls).toHaveLength(1);
  });

  it('filters GET /map/places by shop name, country, blockchain, and asset', async () => {
    const api = app({ token: 'secret' });
    const match = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        ...body,
        externalId: 'match',
        country: 'CH',
        shopName: 'SPAR',
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
        country: 'DE',
        shopName: 'Migros',
        supports: [
          { blockchain: 'Polygon', asset: 'ZCHF' },
          { blockchain: 'Ethereum', asset: 'ETH' },
        ],
      }),
    });
    expect(other.status).toBe(201);
    const filtered = await api.request(
      '/map/places?shopName=SPAR&country=CH&blockchain=Ethereum&asset=ZCHF',
    );
    expect(filtered.status).toBe(200);
    const filteredJson = (await filtered.json()) as {
      places: Array<{ name: string; country: string | null; shopName: string | null }>;
    };
    expect(filteredJson.places).toHaveLength(1);
    expect(filteredJson.places[0]?.shopName).toBe('SPAR');
    expect(filteredJson.places[0]?.country).toBe('CH');
    const others = await api.request('/map/places?shopName=others');
    const othersJson = (await others.json()) as { places: Array<{ shopName: string | null }> };
    expect(othersJson.places).toHaveLength(1);
    expect(othersJson.places[0]?.shopName).toBe('Migros');
    expect((await api.request('/map/places?shopName=Migros')).status).toBe(400);
    expect(await (await api.request('/map/places?shopName=Migros')).json()).toEqual({
      error: 'Place shop name is invalid',
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

  it('does not treat blockchain and asset on different support rows as one pair', async () => {
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
    expect(mismatchJson.places).toHaveLength(0);
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
    expect(json.places[0]?.supports).toEqual([{ blockchain: 'Ethereum', asset: 'dEURO' }]);
  });

  it('returns GET /map/filters from stored rows and rejects a bad blockchain', async () => {
    const api = app({ token: 'secret' });
    const created = await api.request('/map/places', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        ...body,
        country: 'CH',
        shopName: 'SPAR',
        supports: [
          { blockchain: 'Ethereum', asset: 'ZCHF' },
          { blockchain: 'Polygon', asset: 'ETH' },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const filters = await api.request('/map/filters');
    expect(filters.status).toBe(200);
    expect(await filters.json()).toEqual(
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
      body: JSON.stringify({ ...body, externalId: 'store-old' }),
    });
    expect(other.status).toBe(201);
    const noneRes = await api.request('/map/places/transactions', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ origin: 'dfx', externalId: 'store-old', occurredAt: oldIso }),
    });
    expect(noneRes.status).toBe(200);
    expect(await noneRes.json()).toEqual({ activity: 'none' });
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
});
