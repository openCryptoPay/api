import { describe, expect, it } from 'vitest';
import { createApp } from '@/server';
import { MemoryMapPlaceStore } from '@/lib/map/store';

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
}) {
  return createApp({
    store: new MemoryMapPlaceStore(),
    env: opts.env ?? {},
    fetchImpl: opts.fetchImpl ?? (async () => new Response('{}', { status: 201 })),
    ...(opts.token === undefined ? {} : { ingestToken: opts.token }),
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
});
