import { generateKeyPairSync } from 'node:crypto';
import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AdminPublicKey } from '@/lib/admin/keys';
import { signAdminRequest } from '@/lib/admin/signature';
import { npubEncode } from '@/lib/map/nostr-key';
import type { MapPlaceInput } from '@/lib/map/place';
import { MemoryMapPlaceStore, type ReplaceByIdInput } from '@/lib/map/store';
import { createApp } from '@/server';
import { keyFor, keyedStore, withKey } from '../map/keys';
import { base64, simplePng } from '../map/photo-fixtures';

const DESCRIPTION =
  'SPAR supermarket in Triesen. Customers can pay with Bitcoin and other crypto assets through OpenCryptoPay at the checkout.';

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = 1_700_000_000;
const ADMIN_HOST = 'api.example.test';
const REQUEST_HOST = 'evil.test';

const pair = generateKeyPairSync('ed25519');
const desk: AdminPublicKey = { name: 'desk', publicKey: pair.publicKey };

const pin: MapPlaceInput = {
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
  supports: [],
};

const fremd: MapPlaceInput = withKey({ ...pin, origin: 'fremd', externalId: 'shop-9' });

class MissingOnReplace extends MemoryMapPlaceStore {
  override replaceById(_input: ReplaceByIdInput): { status: 'missing' } {
    return { status: 'missing' };
  }
}

type Over = {
  host?: string;
  timestamp?: number;
  keyName?: string;
  nonce?: string;
  send?: Uint8Array;
};

function build(opts?: {
  omitKeys?: boolean;
  omitHost?: boolean;
  token?: string;
  store?: MemoryMapPlaceStore;
}): Hono {
  return createApp({
    publicBaseUrl: 'https://api.test',
    store: opts?.store ?? new MemoryMapPlaceStore(),
    env: {},
    fetchImpl: async () => new Response('{}', { status: 201 }),
    now: () => NOW_MS,
    ...(opts?.omitKeys ? {} : { adminKeys: [desk] }),
    ...(opts?.omitHost ? {} : { adminHost: ADMIN_HOST }),
    ...(opts?.token === undefined ? {} : { ingestToken: opts.token }),
  });
}

function bind(
  api: ReturnType<typeof build>,
): (
  method: string,
  pathWithQuery: string,
  body?: Uint8Array,
  overrides?: Over,
) => Promise<Response> {
  return async function signed(
    method: string,
    pathWithQuery: string,
    body?: Uint8Array,
    overrides?: Over,
  ): Promise<Response> {
    const bytes = body ?? new Uint8Array();
    const headers = signAdminRequest({
      method,
      host: overrides?.host ?? ADMIN_HOST,
      pathWithQuery,
      timestamp: overrides?.timestamp ?? NOW_SECONDS,
      body: bytes,
      privateKey: pair.privateKey,
      keyName: overrides?.keyName ?? 'desk',
      ...(overrides?.nonce === undefined ? {} : { nonce: overrides.nonce }),
    });
    const init: RequestInit = { method, headers: { ...headers } };
    const wire = overrides?.send ?? (body === undefined ? undefined : bytes);
    if (wire !== undefined) {
      init.body = wire;
    }
    // Request host is evil.test. The signature uses api.example.test.
    return api.request(`http://${REQUEST_HOST}${pathWithQuery}`, init);
  };
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value));
}

async function expectUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'Unauthorized' });
}

describe('admin routes', () => {
  it('answers 503 when admin keys are missing', async () => {
    const signed = bind(build({ omitKeys: true }));
    const response = await signed('GET', '/admin/places');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Admin is not configured' });
  });

  it('uses the real clock when no clock is injected', async () => {
    const api = createApp({
      publicBaseUrl: 'https://api.test',
      store: new MemoryMapPlaceStore(),
      env: {},
      fetchImpl: async () => new Response('{}', { status: 201 }),
      adminKeys: [desk],
      adminHost: ADMIN_HOST,
    });
    const headers = signAdminRequest({
      method: 'GET',
      host: ADMIN_HOST,
      pathWithQuery: '/admin/places',
      timestamp: Math.floor(Date.now() / 1000),
      body: new Uint8Array(),
      privateKey: pair.privateKey,
      keyName: 'desk',
    });
    const response = await api.request(`http://${REQUEST_HOST}/admin/places`, {
      method: 'GET',
      headers: { ...headers },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ places: [] });
  });

  it('answers 503 when the admin host is missing', async () => {
    const signed = bind(build({ omitHost: true }));
    const response = await signed('GET', '/admin/places');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Admin is not configured' });
  });

  it('rejects a request with a missing admin header', async () => {
    const api = build();
    const names = [
      'OCP-Admin-Key',
      'OCP-Admin-Timestamp',
      'OCP-Admin-Signature',
      'OCP-Admin-Nonce',
    ] as const;
    for (const name of names) {
      const headers: Record<string, string> = {
        ...signAdminRequest({
          method: 'GET',
          host: ADMIN_HOST,
          pathWithQuery: '/admin/places',
          timestamp: NOW_SECONDS,
          body: new Uint8Array(),
          privateKey: pair.privateKey,
          keyName: 'desk',
        }),
      };
      delete headers[name];
      const response = await api.request(`http://${REQUEST_HOST}/admin/places`, { headers });
      await expectUnauthorized(response);
    }
  });

  it('rejects an unknown key', async () => {
    const signed = bind(build());
    const response = await signed('GET', '/admin/places', undefined, { keyName: 'other' });
    await expectUnauthorized(response);
  });

  it('rejects an expired timestamp', async () => {
    const signed = bind(build());
    const response = await signed('GET', '/admin/places', undefined, {
      timestamp: NOW_SECONDS - 61,
    });
    await expectUnauthorized(response);
  });

  it('rejects a signature for a different host', async () => {
    const signed = bind(build());
    const response = await signed('GET', '/admin/places', undefined, { host: 'other.example' });
    await expectUnauthorized(response);
  });

  it('rejects a body that differs from the signed bytes', async () => {
    const signed = bind(build());
    const response = await signed('PUT', '/admin/places', jsonBytes(fremd), {
      send: jsonBytes({ ...fremd, name: 'Andere Filiale' }),
    });
    await expectUnauthorized(response);
  });

  it('answers 413 for a signed body above 64 KiB', async () => {
    const signed = bind(build());
    const response = await signed('PUT', '/admin/places', new Uint8Array(64 * 1024 + 1));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload too large' });
  });

  it('answers 413 for an unsigned body above 64 KiB', async () => {
    const response = await build().request(`http://${REQUEST_HOST}/admin/places`, {
      method: 'PUT',
      body: new Uint8Array(64 * 1024 + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload too large' });
  });

  it('answers 503 before limiting an oversized body when admin is unconfigured', async () => {
    const response = await build({ omitKeys: true }).request(
      `http://${REQUEST_HOST}/admin/places`,
      {
        method: 'PUT',
        body: new Uint8Array(64 * 1024 + 1),
      },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Admin is not configured' });
  });

  it('accepts two requests that differ only by nonce', async () => {
    const signed = bind(build());
    expect((await signed('GET', '/admin/places')).status).toBe(200);
    expect((await signed('GET', '/admin/places')).status).toBe(200);
  });

  it('rejects a replay of the same nonce', async () => {
    const signed = bind(build());
    const overrides: Over = { nonce: 'replay-nonce-012345' };
    expect((await signed('GET', '/admin/places', undefined, overrides)).status).toBe(200);
    await expectUnauthorized(await signed('GET', '/admin/places', undefined, overrides));
  });

  it('rejects a malformed nonce', async () => {
    const api = build();
    const headers: Record<string, string> = {
      ...signAdminRequest({
        method: 'GET',
        host: ADMIN_HOST,
        pathWithQuery: '/admin/places',
        timestamp: NOW_SECONDS,
        body: new Uint8Array(),
        privateKey: pair.privateKey,
        keyName: 'desk',
      }),
    };
    headers['OCP-Admin-Nonce'] = 'short';
    const response = await api.request(`http://${REQUEST_HOST}/admin/places`, { headers });
    await expectUnauthorized(response);
  });

  it('lists complete and incomplete places', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const first = store.insertIfNew(withKey(pin));
    store.insertIfNew(withKey({ ...pin, externalId: 'blank', name: '' }));
    store.insertIfNew(
      withKey({ ...pin, externalId: 'cash', paymentMethods: null, name: 'Cash Shop' }),
    );
    if (!first.ok) {
      throw new Error(first.error);
    }
    const response = await bind(build({ store }))('GET', '/admin/places');
    expect(response.status).toBe(200);
    const listed = (await response.json()) as {
      places: Array<{
        name: string;
        complete: boolean;
        problems: string[];
        externalId: string;
        paymentMethods: string | null;
      }>;
    };
    const complete = listed.places.find((place) => place.name === pin.name);
    const incomplete = listed.places.find((place) => place.name === '');
    const cash = listed.places.find((place) => place.externalId === 'cash');
    expect(complete).toMatchObject({
      complete: true,
      problems: [],
      externalId: 'store-1',
      paymentMethods: 'lightning',
      createdAt: new Date(NOW_MS).toISOString(),
      lastTransactionAt: null,
      active: true,
      id: first.place.id,
      npub: npubEncode(first.place.nostrPubkey ?? ''),
      coverPhoto: null,
    });
    if (complete === undefined) {
      throw new Error('missing complete place');
    }
    expect(Object.keys(complete).sort()).toEqual(
      [
        'active',
        'activity',
        'category',
        'city',
        'complete',
        'country',
        'coverPhoto',
        'createdAt',
        'description',
        'externalId',
        'googleMapsUrl',
        'houseNumber',
        'id',
        'lastTransactionAt',
        'lat',
        'lon',
        'name',
        'npub',
        'origin',
        'paymentMethods',
        'postalCode',
        'problems',
        'shopName',
        'shopType',
        'street',
        'supports',
        'techProvider',
      ].sort(),
    );
    expect(complete).not.toHaveProperty('activityUntil');
    expect(incomplete?.complete).toBe(false);
    expect(incomplete?.problems.length).toBeGreaterThan(0);
    expect(incomplete).toMatchObject({ externalId: 'blank', paymentMethods: 'lightning' });
    expect(cash?.paymentMethods).toBeNull();
  });

  it('creates a foreign origin and then updates it', async () => {
    const signed = bind(build());
    const created = await signed('PUT', '/admin/places', jsonBytes(fremd));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ created: true });
    const updated = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...fremd, name: 'Filiale Nord' }),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ created: false });
  });

  it('rejects an invalid put body', async () => {
    const signed = bind(build());
    const response = await signed('PUT', '/admin/places', Buffer.from('{'));
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
  });

  it('rejects an empty put body', async () => {
    const signed = bind(build());
    const response = await signed('PUT', '/admin/places', new Uint8Array());
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
  });

  it('deletes a stored place and reports a miss', async () => {
    const signed = bind(build());
    const miss = await signed(
      'DELETE',
      '/admin/places',
      jsonBytes({ origin: 'fremd', externalId: 'missing' }),
    );
    expect(miss.status).toBe(200);
    expect(await miss.json()).toEqual({ deleted: false });
    await signed('PUT', '/admin/places', jsonBytes(fremd));
    const hit = await signed(
      'DELETE',
      '/admin/places',
      jsonBytes({ origin: 'fremd', externalId: 'shop-9' }),
    );
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({ deleted: true });
  });

  it('rejects an invalid delete body', async () => {
    const signed = bind(build());
    const response = await signed('DELETE', '/admin/places', Buffer.from('nope'));
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
  });

  function adminWithMap(store: MemoryMapPlaceStore): {
    calls: string[];
    signed: ReturnType<typeof bind>;
  } {
    const calls: string[] = [];
    const api = createApp({
      store,
      env: { BTCMAP_ACCESS_TOKEN: 'map-token' },
      fetchImpl: async (input: string) => {
        calls.push(input);
        return new Response('{}', { status: 201 });
      },
      now: () => NOW_MS,
      adminKeys: [desk],
      adminHost: ADMIN_HOST,
      publicBaseUrl: 'https://api.test',
    });
    return { calls, signed: bind(api) };
  }

  it('upserts and may create when the body has no id', async () => {
    const { calls, signed } = adminWithMap(new MemoryMapPlaceStore(() => new Date(NOW_MS)));
    const keyed = withKey(fremd);
    const created = await signed('PUT', '/admin/places', jsonBytes(keyed));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { created: boolean; id: string; btcmap: string };
    expect(createdBody.created).toBe(true);
    expect(createdBody.btcmap).toBe('sent');
    expect(typeof createdBody.id).toBe('string');
    expect(calls).toHaveLength(1);
    const updated = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...keyed, name: 'Filiale Nord' }),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      created: false,
      id: createdBody.id,
      btcmap: 'skipped',
    });
    expect(calls).toHaveLength(1);
  });

  it('rejects a blank or non-string internal id and does not trim it', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const { calls, signed } = adminWithMap(store);
    for (const id of ['', '   ', null, 1, false, [], {}]) {
      const response = await signed(
        'PUT',
        '/admin/places',
        jsonBytes({ ...pin, id, name: 'Should Not Stick' }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Place id is required' });
    }
    const padded = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: ` ${created.place.id} `, name: 'Should Not Stick' }),
    );
    expect(padded.status).toBe(404);
    expect(await padded.json()).toEqual({ error: 'Place not found' });
    expect(calls).toEqual([]);
    expect(store.getById(created.place.id)?.name).toBe(pin.name);
  });

  it('returns 404 for an unknown id and does not insert or call BTC Map', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const { calls, signed } = adminWithMap(store);
    const missing = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({
        ...pin,
        id: 'missing-id',
        origin: 'other',
        externalId: 'brand-new',
        name: 'Should Not Insert',
      }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Place not found' });
    const badOrigin = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ id: 'also-missing', origin: 'BAD', externalId: 'brand-new' }),
    );
    expect(badOrigin.status).toBe(404);
    expect(await badOrigin.json()).toEqual({ error: 'Place not found' });
    expect(calls).toEqual([]);
    expect(store.listAll()).toHaveLength(1);
    expect(store.getById(created.place.id)?.name).toBe(pin.name);
    expect(store.listAll().some((row) => row.externalId === 'brand-new')).toBe(false);
  });

  it('rejects an invalid origin or caller id and moves a free pair onto the same id', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const { calls, signed } = adminWithMap(store);
    const cases: Array<{ body: Record<string, unknown>; error: string }> = [
      {
        body: { origin: 'BAD', externalId: 'bad\nid', createdAt: null },
        error: 'Place origin is invalid',
      },
      { body: { externalId: '', createdAt: 1 }, error: 'Place external id is required' },
      { body: { externalId: '   ' }, error: 'Place external id is required' },
      { body: { origin: 'dfx', externalId: 'bad\nid' }, error: 'Place external id is required' },
    ];
    for (const item of cases) {
      const response = await signed(
        'PUT',
        '/admin/places',
        jsonBytes({ ...pin, ...item.body, id: created.place.id, name: 'Should Not Stick' }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: item.error });
    }
    expect(store.getById(created.place.id)?.name).toBe(pin.name);
    const moved = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({
        ...pin,
        id: created.place.id,
        origin: ' fremd ',
        externalId: ' moved-1 ',
        name: 'Moved Shop',
        createdAt: '2020-05-01T00:00:00Z',
      }),
    );
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({
      created: false,
      id: created.place.id,
      npub: expect.stringMatching(/^npub1/),
      btcmap: 'skipped',
    });
    expect(calls).toEqual([]);
    expect(store.listAll()).toHaveLength(1);
    expect(
      store.listAll().some((row) => row.origin === 'dfx' && row.externalId === 'store-1'),
    ).toBe(false);
    expect(store.getById(created.place.id)).toMatchObject({
      id: created.place.id,
      origin: 'fremd',
      externalId: 'moved-1',
      name: 'Moved Shop',
      createdAt: '2020-05-01T00:00:00.000Z',
      lastTransactionAt: null,
      activity: 'none',
    });
  });

  it('does not write when the internal-id body fails place validation', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const { calls, signed } = adminWithMap(store);
    const badLat = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: created.place.id, lat: 999, name: 'Should Not Stick' }),
    );
    expect(badLat.status).toBe(400);
    expect(await badLat.json()).toEqual({ error: 'Place must be a latitude and longitude' });
    const activityUntil = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({
        ...pin,
        id: created.place.id,
        activityUntil: '2026-10-01T00:00:00.000Z',
        name: 'Should Not Stick',
      }),
    );
    expect(activityUntil.status).toBe(400);
    expect(await activityUntil.json()).toEqual({
      error: 'Place field is not allowed: activityUntil',
    });
    expect(calls).toEqual([]);
    expect(store.getById(created.place.id)?.name).toBe(pin.name);
    expect(store.getById(created.place.id)?.activity).toBe('none');
  });

  it('replaces operator columns by internal id and leaves identity and activity state', async () => {
    const otherDescription =
      'Neighbourhood grocery in Zürich. Customers can pay with Bitcoin and other crypto assets through OpenCryptoPay at the checkout.';
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    const created = keyedStore(store).insertIfNew({
      ...pin,
      techProvider: '21.gifts',
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    const other = keyedStore(store).insertIfNew({
      ...pin,
      externalId: 'store-2',
      name: 'Second Shop',
    });
    const day = (value: string): string => `${value}T12:00:00.000Z`;
    store.recordTransaction('dfx', 'store-1', day('2026-10-05'), nowMs);
    store.recordTransaction('dfx', 'store-1', day('2026-10-06'), nowMs);
    store.recordTransaction('dfx', 'store-1', day('2026-10-07'), nowMs);
    store.recordTransaction('dfx', 'store-1', day('2026-10-08'), nowMs);
    const before = store.getById(created.place.id);
    if (before === undefined) {
      throw new Error('missing stored place');
    }
    expect(before.activity).toBe('within7Days');
    expect(before.lastTransactionAt).toBe(day('2026-10-08'));
    const { calls, signed } = adminWithMap(store);
    const replaced = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({
        id: before.id,
        name: 'Other Shop',
        description: otherDescription,
        lat: 46.5,
        lon: 7.5,
        category: 'cafe',
        paymentMethods: 'onchain,lightning',
        techProvider: 'Acme.pay',
        shopType: 'Others',
        street: 'Bahnhofstrasse',
        houseNumber: '12',
        postalCode: '8001',
        city: 'Zürich',
        country: 'CH',
        supports: [{ blockchain: 'Bitcoin', asset: 'BTC' }],
      }),
    );
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({
      created: false,
      id: before.id,
      npub: expect.stringMatching(/^npub1/),
      btcmap: 'skipped',
    });
    expect(calls).toEqual([]);
    const after = store.getById(before.id);
    expect(after).toMatchObject({
      id: before.id,
      origin: 'dfx',
      externalId: 'store-1',
      createdAt: before.createdAt,
      lastTransactionAt: before.lastTransactionAt,
      activity: 'within7Days',
      name: 'Other Shop',
      description: otherDescription,
      lat: 46.5,
      lon: 7.5,
      category: 'cafe',
      paymentMethods: 'onchain,lightning',
      techProvider: 'Acme.pay',
      shopType: 'Others',
      street: 'Bahnhofstrasse',
      houseNumber: '12',
      postalCode: '8001',
      city: 'Zürich',
      country: 'CH',
      supports: [{ blockchain: 'Bitcoin', asset: 'BTC' }],
    });
    const listed = await signed('GET', '/admin/places');
    const body = (await listed.json()) as {
      places: Array<Record<string, unknown>>;
    };
    const item = body.places.find((place) => place['id'] === before.id);
    expect(item).toMatchObject({
      name: 'Other Shop',
      externalId: 'store-1',
      paymentMethods: 'onchain,lightning',
      origin: 'dfx',
      activity: 'within7Days',
      createdAt: before.createdAt,
      lastTransactionAt: before.lastTransactionAt,
    });
    expect(item).not.toHaveProperty('activityUntil');
    const fifth = store.recordTransaction('dfx', 'store-1', day('2026-10-04'), nowMs);
    expect(fifth?.activity).toBe('daily');
    expect(fifth?.lastTransactionAt).toBe(day('2026-10-08'));
    const cleared = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({
        id: before.id,
        name: 'Other Shop',
        description: otherDescription,
        lat: 46.5,
        lon: 7.5,
        category: 'cafe',
        shopType: 'Others',
        street: 'Bahnhofstrasse',
        houseNumber: '12',
        postalCode: '8001',
        city: 'Zürich',
        country: 'CH',
      }),
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      created: false,
      id: before.id,
      npub: expect.stringMatching(/^npub1/),
      btcmap: 'skipped',
    });
    expect(store.getById(before.id)).toMatchObject({
      id: before.id,
      origin: 'dfx',
      externalId: 'store-1',
      createdAt: before.createdAt,
      lastTransactionAt: day('2026-10-08'),
      activity: 'daily',
      techProvider: 'DFX.swiss',
      paymentMethods: null,
      supports: [],
    });
    const still = store.recordTransaction('dfx', 'store-1', day('2026-10-08'), nowMs);
    expect(still?.activity).toBe('daily');
    expect(still?.lastTransactionAt).toBe(day('2026-10-08'));
    expect(store.getById(other.place.id)?.name).toBe('Second Shop');
    expect(store.listAll()).toHaveLength(2);
    expect(calls).toEqual([]);
  });

  it('keeps activityUntil across an internal-id replace', async () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    const created = keyedStore(store).insertIfNew({ ...pin, techProvider: '21.gifts' });
    const last = '2026-10-08T12:00:00.000Z';
    store.recordTransaction(pin.origin, pin.externalId, last, nowMs);
    const until = Date.parse(last) + 7 * 24 * 60 * 60 * 1000 + 1;
    const { calls, signed } = adminWithMap(store);
    const replaced = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: created.place.id, name: 'Renamed' }),
    );
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({
      created: false,
      id: created.place.id,
      npub: expect.stringMatching(/^npub1/),
      btcmap: 'skipped',
    });
    expect(calls).toEqual([]);
    expect(store.getById(created.place.id)).toMatchObject({
      id: created.place.id,
      origin: pin.origin,
      externalId: pin.externalId,
      createdAt: created.place.createdAt,
      name: 'Renamed',
      lastTransactionAt: last,
      activity: 'within7Days',
    });
    store.refreshActivity(until - 1);
    expect(store.getById(created.place.id)?.activity).toBe('within7Days');
    store.refreshActivity(until);
    expect(store.getById(created.place.id)?.activity).toBe('within30Days');
    expect(store.getById(created.place.id)?.lastTransactionAt).toBe(last);
  });

  it('rejects an invalid createdAt and writes nothing', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const { calls, signed } = adminWithMap(store);
    const cases: unknown[] = [null, 1, '', '   ', 'not-a-date', '-000001-01-01T00:00:00.000Z'];
    for (const createdAt of cases) {
      const response = await signed(
        'PUT',
        '/admin/places',
        jsonBytes({
          ...pin,
          id: created.place.id,
          createdAt,
          ...(createdAt === null ? { activity: 'nope' } : {}),
          name: 'Should Not Stick',
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Place created time is invalid' });
    }
    expect(calls).toEqual([]);
    expect(store.getById(created.place.id)).toMatchObject({
      name: pin.name,
      createdAt: created.place.createdAt,
      lastTransactionAt: null,
      activity: 'none',
    });
  });

  it('rejects an invalid lastTransactionAt and writes an older instant', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const recent = new Date(NOW_MS).toISOString();
    store.recordTransaction(pin.origin, pin.externalId, recent, NOW_MS);
    const { calls, signed } = adminWithMap(store);
    const cases: unknown[] = [1, '', '   ', 'not-a-date', '-000001-01-01T00:00:00.000Z', false, {}];
    for (const lastTransactionAt of cases) {
      const response = await signed(
        'PUT',
        '/admin/places',
        jsonBytes({
          ...pin,
          id: created.place.id,
          lastTransactionAt,
          ...(lastTransactionAt === 1 ? { activity: 'nope' } : {}),
          name: 'Should Not Stick',
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Place transaction time is invalid' });
    }
    expect(store.getById(created.place.id)?.lastTransactionAt).toBe(recent);
    expect(store.getById(created.place.id)?.name).toBe(pin.name);
    const older = new Date(NOW_MS - 40 * 24 * 60 * 60 * 1000).toISOString();
    const written = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: created.place.id, lastTransactionAt: older, name: 'Older Instant' }),
    );
    expect(written.status).toBe(200);
    expect(await written.json()).toEqual({
      created: false,
      id: created.place.id,
      npub: expect.stringMatching(/^npub1/),
      btcmap: 'skipped',
    });
    expect(calls).toEqual([]);
    expect(store.getById(created.place.id)).toMatchObject({
      name: 'Older Instant',
      lastTransactionAt: older,
      activity: 'olderThan30Days',
      createdAt: created.place.createdAt,
    });
  });

  it('clears lastTransactionAt when the JSON value is null and recomputes activity', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const recent = new Date(NOW_MS).toISOString();
    store.recordTransaction(pin.origin, pin.externalId, recent, NOW_MS);
    expect(store.getById(created.place.id)?.activity).toBe('within7Days');
    const { calls, signed } = adminWithMap(store);
    const response = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: created.place.id, lastTransactionAt: null, name: 'Cleared' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      created: false,
      id: created.place.id,
      npub: expect.stringMatching(/^npub1/),
      btcmap: 'skipped',
    });
    expect(calls).toEqual([]);
    expect(store.getById(created.place.id)).toMatchObject({
      name: 'Cleared',
      lastTransactionAt: null,
      activity: 'none',
      createdAt: created.place.createdAt,
    });
    store.refreshActivity(NOW_MS + 8 * 24 * 60 * 60 * 1000);
    expect(store.getById(created.place.id)?.activity).toBe('none');
  });

  it('rejects an activity token that is not exact and writes nothing', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const { calls, signed } = adminWithMap(store);
    for (const activity of [' daily', 'daily ', 'Daily', 'none ', '', 'nope', null, 1, true]) {
      const response = await signed(
        'PUT',
        '/admin/places',
        jsonBytes({
          ...pin,
          id: created.place.id,
          createdAt: '2020-01-01T00:00:00.000Z',
          activity,
          name: 'Should Not Stick',
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Place activity is invalid' });
    }
    expect(calls).toEqual([]);
    expect(store.getById(created.place.id)).toMatchObject({
      name: pin.name,
      createdAt: created.place.createdAt,
      activity: 'none',
    });
  });

  it('stores an exact activity token, keeps it across refresh, and leaves payment days', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const day = (value: string): string => `${value}T12:00:00.000Z`;
    store.recordTransaction(pin.origin, pin.externalId, day('2023-11-11'), NOW_MS);
    store.recordTransaction(pin.origin, pin.externalId, day('2023-11-12'), NOW_MS);
    store.recordTransaction(pin.origin, pin.externalId, day('2023-11-13'), NOW_MS);
    store.recordTransaction(pin.origin, pin.externalId, day('2023-11-14'), NOW_MS);
    expect(store.getById(created.place.id)?.activity).toBe('within7Days');
    const { calls, signed } = adminWithMap(store);
    const set = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: created.place.id, activity: 'none' }),
    );
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({
      created: false,
      id: created.place.id,
      npub: expect.stringMatching(/^npub1/),
      btcmap: 'skipped',
    });
    expect(store.getById(created.place.id)?.activity).toBe('none');
    expect(store.getById(created.place.id)?.lastTransactionAt).toBe(day('2023-11-14'));
    store.refreshActivity(NOW_MS + 40 * 24 * 60 * 60 * 1000);
    expect(store.getById(created.place.id)?.activity).toBe('none');
    const kept = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: created.place.id, name: 'Token Kept' }),
    );
    expect(kept.status).toBe(200);
    expect(store.getById(created.place.id)).toMatchObject({
      name: 'Token Kept',
      activity: 'none',
      lastTransactionAt: day('2023-11-14'),
    });
    const fifth = store.recordTransaction(pin.origin, pin.externalId, day('2023-11-10'), NOW_MS);
    expect(fifth?.activity).toBe('daily');
    expect(fifth?.lastTransactionAt).toBe(day('2023-11-14'));
    expect(calls).toEqual([]);
  });

  it('returns 409 when the origin and caller id belong to another row', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const first = keyedStore(store).insertIfNew(pin);
    const second = keyedStore(store).insertIfNew({
      ...pin,
      origin: 'fremd',
      externalId: 'store-2',
      name: 'Second Shop',
    });
    const beforeFirst = store.getById(first.place.id);
    const beforeSecond = store.getById(second.place.id);
    const { calls, signed } = adminWithMap(store);
    const response = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({
        ...pin,
        id: first.place.id,
        origin: 'fremd',
        externalId: 'store-2',
        name: 'Should Not Stick',
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Place already exists' });
    expect(calls).toEqual([]);
    expect(store.listAll()).toHaveLength(2);
    expect(store.getById(first.place.id)).toEqual(beforeFirst);
    expect(store.getById(second.place.id)).toEqual(beforeSecond);
  });

  it('returns 404 when replaceById reports the id missing and writes nothing', async () => {
    const store = new MissingOnReplace(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const { calls, signed } = adminWithMap(store);
    const response = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: created.place.id, name: 'Should Not Stick' }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Place not found' });
    expect(calls).toEqual([]);
    expect(store.listAll()).toHaveLength(1);
    expect(store.getById(created.place.id)?.name).toBe(pin.name);
  });

  it('rejects createdAt, lastTransactionAt, and activity on PUT without an internal id', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const api = build({ store, token: 'secret' });
    const signed = bind(api);
    const fields = [
      ['createdAt', '2020-01-01T00:00:00.000Z'],
      ['lastTransactionAt', '2020-01-02T00:00:00.000Z'],
      ['activity', 'daily'],
    ] as const;
    for (const [field, value] of fields) {
      const mapResponse = await api.request('/map/places', {
        method: 'PUT',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...pin, [field]: value, name: 'Should Not Stick' }),
      });
      expect(mapResponse.status).toBe(400);
      expect(await mapResponse.json()).toEqual({ error: `Place field is not allowed: ${field}` });
      const adminResponse = await signed(
        'PUT',
        '/admin/places',
        jsonBytes({ ...pin, [field]: value, name: 'Should Not Stick' }),
      );
      expect(adminResponse.status).toBe(400);
      expect(await adminResponse.json()).toEqual({
        error: `Place field is not allowed: ${field}`,
      });
    }
    expect(store.listAll()).toHaveLength(1);
    expect(store.getById(created.place.id)).toMatchObject({
      name: pin.name,
      createdAt: created.place.createdAt,
      lastTransactionAt: null,
      activity: 'none',
    });
  });

  it('keeps the stored origin and caller id when they are omitted or match', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const signed = bind(build({ store }));
    const base = {
      name: 'Origin Kept',
      description: pin.description,
      lat: pin.lat,
      lon: pin.lon,
      category: pin.category,
      paymentMethods: pin.paymentMethods,
      shopType: pin.shopType,
      street: pin.street,
      houseNumber: pin.houseNumber,
      postalCode: pin.postalCode,
      city: pin.city,
      country: pin.country,
    };
    const withOrigin = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...base, id: created.place.id, origin: ' dfx ' }),
    );
    expect(withOrigin.status).toBe(200);
    expect(await withOrigin.json()).toEqual({
      created: false,
      id: created.place.id,
      npub: expect.stringMatching(/^npub1/),
      btcmap: 'skipped',
    });
    expect(store.getById(created.place.id)).toMatchObject({
      name: 'Origin Kept',
      origin: 'dfx',
      externalId: 'store-1',
    });
    const withExternal = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...base, id: created.place.id, externalId: ' store-1 ', name: 'Caller Kept' }),
    );
    expect(withExternal.status).toBe(200);
    expect(store.getById(created.place.id)).toMatchObject({
      name: 'Caller Kept',
      origin: 'dfx',
      externalId: 'store-1',
    });
  });

  it('deletes by internal id and leaves a different row', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const first = keyedStore(store).insertIfNew(pin);
    const second = keyedStore(store).insertIfNew({
      ...pin,
      externalId: 'store-2',
      name: 'Second Row',
    });
    const signed = bind(build({ store }));
    const removed = await signed(
      'DELETE',
      '/admin/places',
      jsonBytes({ id: first.place.id, note: 'ignored' }),
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true });
    expect(store.getById(first.place.id)).toBeUndefined();
    expect(store.getById(second.place.id)?.externalId).toBe('store-2');
    const matched = await signed(
      'DELETE',
      '/admin/places',
      jsonBytes({ id: second.place.id, origin: ' dfx ', externalId: ' store-2 ' }),
    );
    expect(matched.status).toBe(200);
    expect(await matched.json()).toEqual({ deleted: true });
    expect(store.listAll()).toHaveLength(0);
  });

  it('does not delete an unknown id, even when origin is present', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const signed = bind(build({ store }));
    const wrongId = await signed(
      'DELETE',
      '/admin/places',
      jsonBytes({ id: 'missing-id', origin: 'dfx', externalId: 'store-1' }),
    );
    expect(wrongId.status).toBe(200);
    expect(await wrongId.json()).toEqual({ deleted: false });
    const badOrigin = await signed(
      'DELETE',
      '/admin/places',
      jsonBytes({ id: 'missing-id', origin: 'NOT AN ORIGIN' }),
    );
    expect(badOrigin.status).toBe(200);
    expect(await badOrigin.json()).toEqual({ deleted: false });
    const padded = await signed(
      'DELETE',
      '/admin/places',
      jsonBytes({ id: ` ${created.place.id}` }),
    );
    expect(padded.status).toBe(200);
    expect(await padded.json()).toEqual({ deleted: false });
    expect(store.getById(created.place.id)?.externalId).toBe('store-1');
    expect(store.listAll()).toHaveLength(1);
  });

  it('does not delete when the internal-id origin or caller id does not match', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const signed = bind(build({ store }));
    const cases: Array<{ body: Record<string, unknown>; error: string }> = [
      { body: { origin: 'fremd', externalId: 'other' }, error: 'Place origin does not match' },
      { body: { origin: 'BAD', externalId: 'store-1' }, error: 'Place origin is invalid' },
      { body: { origin: 'dfx', externalId: 'other' }, error: 'Place external id does not match' },
      { body: { externalId: ' ' }, error: 'Place external id is required' },
    ];
    for (const item of cases) {
      const response = await signed(
        'DELETE',
        '/admin/places',
        jsonBytes({ id: created.place.id, ...item.body }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: item.error });
    }
    expect(store.getById(created.place.id)?.name).toBe(pin.name);
  });

  it('rejects a blank or non-string id on delete and deletes nothing', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    keyedStore(store).insertIfNew(pin);
    const signed = bind(build({ store }));
    for (const id of ['', '   ', null, 1, false]) {
      const response = await signed(
        'DELETE',
        '/admin/places',
        jsonBytes({ id, origin: 'dfx', externalId: 'store-1' }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Place id is required' });
    }
    expect(store.listAll()).toHaveLength(1);
    expect(store.listAll()[0]?.externalId).toBe('store-1');
  });

  it('rejects an npub or a revision beside an internal id and changes nothing', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const npub = npubEncode(created.place.nostrPubkey ?? '');
    const signed = bind(build({ store }));
    for (const method of ['PUT', 'DELETE']) {
      const byNpub = await signed(method, '/admin/places', jsonBytes({ ...pin, id: npub }));
      expect(byNpub.status).toBe(400);
      expect(await byNpub.json()).toEqual({ error: 'Place id is the internal id, not the npub' });
      const withRevision = await signed(
        method,
        '/admin/places',
        jsonBytes({ ...pin, id: created.place.id, revision: 9 }),
      );
      expect(withRevision.status).toBe(400);
      expect(await withRevision.json()).toEqual({
        error: 'Place field is not allowed: revision',
      });
    }
    expect(store.getById(created.place.id)).toEqual(created.place);
  });

  it('answers 400 for a missing key and 409 for a reserved or changed key on an internal-id write', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const keyless = store.insertIfNew(pin);
    const other = keyedStore(store).insertIfNew({
      ...pin,
      externalId: 'store-2',
      name: 'Second Row',
    });
    if (!keyless.ok) {
      throw new Error(keyless.error);
    }
    const signed = bind(build({ store }));
    const stillKeyless = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: keyless.place.id, name: 'Still Keyless' }),
    );
    expect(stillKeyless.status).toBe(400);
    expect(await stillKeyless.json()).toEqual({ error: 'Place NOSTR public key is required' });
    expect(store.getById(keyless.place.id)?.name).toBe(pin.name);
    const reserved = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: keyless.place.id, nostrPubkey: other.place.nostrPubkey }),
    );
    expect(reserved.status).toBe(409);
    expect(await reserved.json()).toEqual({ error: 'nostrPubkey belongs to another place' });
    const changed = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, externalId: 'store-2', id: other.place.id, nostrPubkey: keyFor('new') }),
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: 'nostrPubkey of a place cannot change' });
    const added = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: keyless.place.id, nostrPubkey: keyFor('added') }),
    );
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({
      created: false,
      id: keyless.place.id,
      npub: npubEncode(keyFor('added')),
      btcmap: 'skipped',
    });
  });

  it('hides a shop from public reads when active is false and rejects a bad flag', async () => {
    const store = new MemoryMapPlaceStore(() => new Date(NOW_MS));
    const created = keyedStore(store).insertIfNew(pin);
    const key = created.place.nostrPubkey;
    if (key === null) {
      throw new Error('missing key');
    }
    const npub = npubEncode(key);
    const calls: string[] = [];
    const api = createApp({
      store,
      env: { BTCMAP_ACCESS_TOKEN: 'map-token' },
      fetchImpl: async (input: string) => {
        calls.push(input);
        return new Response('{}', { status: 201 });
      },
      now: () => NOW_MS,
      adminKeys: [desk],
      adminHost: ADMIN_HOST,
      publicBaseUrl: 'https://api.test',
      ingestToken: 'secret',
    });
    const signed = bind(api);
    const before = await api.request('/map/places');
    expect(before.status).toBe(200);
    const beforeJson = (await before.json()) as { places: Array<Record<string, unknown>> };
    const shown = beforeJson.places.find((place) => place['id'] === npub);
    if (shown === undefined) {
      throw new Error('missing public place');
    }
    expect(Object.hasOwn(shown, 'active')).toBe(false);
    for (const active of [1, 'false', null] as const) {
      const rejected = await signed(
        'PUT',
        '/admin/places',
        jsonBytes({ ...pin, id: created.place.id, active, name: 'Should Not Stick' }),
      );
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: 'Place active is invalid' });
    }
    const invalid = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: created.place.id, active: false, lat: 999 }),
    );
    expect(invalid.status).toBe(400);
    expect(store.getById(created.place.id)).toMatchObject({ active: true, name: pin.name });
    const hidden = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: created.place.id, active: false }),
    );
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toEqual({
      created: false,
      id: created.place.id,
      npub,
      btcmap: 'skipped',
    });
    expect(calls).toEqual([]);
    const listed = await api.request('/map/places');
    const listedJson = (await listed.json()) as { places: Array<{ id: string }> };
    expect(listedJson.places.some((place) => place.id === npub)).toBe(false);
    const detail = await api.request(`/map/places/${npub}`);
    expect(detail.status).toBe(404);
    expect(await detail.json()).toEqual({ error: 'Place not found' });
    const hex = await api.request(`/map/places/${key}`);
    expect(hex.status).toBe(404);
    expect(await hex.json()).toEqual({ error: 'Place not found' });
    const admin = await signed('GET', '/admin/places');
    expect(admin.status).toBe(200);
    const adminJson = (await admin.json()) as {
      places: Array<{ id: string; active: boolean; complete: boolean }>;
    };
    expect(adminJson.places.find((place) => place.id === created.place.id)).toMatchObject({
      active: false,
      complete: true,
    });
    const kept = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...pin, id: created.place.id, name: 'Still Hidden' }),
    );
    expect(kept.status).toBe(200);
    expect(await kept.json()).toEqual({
      created: false,
      id: created.place.id,
      npub,
      btcmap: 'skipped',
    });
    expect(store.getById(created.place.id)).toMatchObject({ active: false, name: 'Still Hidden' });
    const mapResponse = await api.request('/map/places', {
      method: 'PUT',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...withKey(pin), active: true, name: 'Should Not Stick' }),
    });
    expect(mapResponse.status).toBe(400);
    expect(await mapResponse.json()).toEqual({ error: 'Place field is not allowed: active' });
    const adminResponse = await signed(
      'PUT',
      '/admin/places',
      jsonBytes({ ...withKey(pin), active: false, name: 'Should Not Stick' }),
    );
    expect(adminResponse.status).toBe(400);
    expect(await adminResponse.json()).toEqual({ error: 'Place field is not allowed: active' });
    expect(store.getById(created.place.id)).toMatchObject({
      active: false,
      name: 'Still Hidden',
    });
    expect(calls).toEqual([]);
  });

  it('returns 404 for a signed unknown path', async () => {
    const signed = bind(build());
    const response = await signed('GET', '/admin/no-such');
    expect(response.status).toBe(404);
  });

  it('still requires the ingest bearer on /map', async () => {
    const api = build({ token: 'secret' });
    const response = await api.request('/map/places', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pin),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });
});

describe('admin photo replace', () => {
  const PHOTOS = '/admin/places/photos';

  function storeWithFremd(): MemoryMapPlaceStore {
    const store = new MemoryMapPlaceStore();
    store.upsert(fremd);
    return store;
  }

  function upload(photos: unknown[], extra: Record<string, unknown> = {}): Uint8Array {
    return jsonBytes({ origin: 'fremd', nostrPubkey: fremd.nostrPubkey, photos, ...extra });
  }

  it('stores the photos of a shop and reports a skipped one', async () => {
    const store = storeWithFremd();
    const signed = bind(build({ store }));
    const response = await signed(
      'PUT',
      PHOTOS,
      upload([
        { contentType: 'image/png', data: base64(simplePng(5, 4)), caption: 'Front' },
        { contentType: 'image/jpeg', data: base64(simplePng(5, 4)) },
      ]),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      photos: Array<{ url: string; width: number; height: number; caption: string | null }>;
      skipped: Array<{ index: number; error: string }>;
    };
    expect(body.photos).toHaveLength(1);
    expect(body.photos[0]).toMatchObject({ width: 5, height: 4, caption: 'Front' });
    expect(body.photos[0]?.url.startsWith('https://api.test/map/photos/')).toBe(true);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]?.index).toBe(1);
  });

  it('answers the errors of the shared photo replace', async () => {
    const signed = bind(build({ store: storeWithFremd() }));
    const invalid = await signed('PUT', PHOTOS, jsonBytes({ photos: 'x' }));
    expect(invalid.status).toBe(400);
    const missing = await signed(
      'PUT',
      PHOTOS,
      jsonBytes({ origin: 'other', nostrPubkey: fremd.nostrPubkey, photos: [] }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Place not found' });
    const first = await signed('PUT', PHOTOS, upload([], { revision: 5 }));
    expect(first.status).toBe(200);
    const stale = await signed('PUT', PHOTOS, upload([], { revision: 5 }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'Stale revision' });
  });

  it('reads a body above 64 KiB on the photo path only', async () => {
    const signed = bind(build({ store: storeWithFremd() }));
    const large = new Uint8Array(64 * 1024 + 1);
    const photo = await signed('PUT', PHOTOS, large);
    expect(photo.status).toBe(400);
    const place = await signed('PUT', '/admin/places', large);
    expect(place.status).toBe(413);
  });

  it('answers 413 for a signed photo body above 15 MiB', async () => {
    const signed = bind(build());
    const response = await signed('PUT', PHOTOS, new Uint8Array(15 * 1_048_576 + 1));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload too large' });
  });

  it('answers 401 before reading a photo body without a known key and a fresh timestamp', async () => {
    const api = build();
    const large = new Uint8Array(1_048_576);
    const headers: Array<Record<string, string>> = [
      {},
      { 'OCP-Admin-Key': 'laptop', 'OCP-Admin-Timestamp': String(NOW_SECONDS) },
      { 'OCP-Admin-Key': 'desk' },
      { 'OCP-Admin-Key': 'desk', 'OCP-Admin-Timestamp': 'soon' },
      { 'OCP-Admin-Key': 'desk', 'OCP-Admin-Timestamp': `${String(NOW_SECONDS)}.0` },
      { 'OCP-Admin-Key': 'desk', 'OCP-Admin-Timestamp': String(NOW_SECONDS - 61) },
      { 'OCP-Admin-Key': 'desk', 'OCP-Admin-Timestamp': String(NOW_SECONDS + 61) },
    ];
    for (const header of headers) {
      const response = await api.request(`http://${REQUEST_HOST}${PHOTOS}`, {
        method: 'PUT',
        headers: header,
        body: large,
      });
      await expectUnauthorized(response);
    }
  });

  it('answers 413 for an oversized photo body whatever key name it sends', async () => {
    const api = build();
    const oversized = new Uint8Array(15 * 1_048_576 + 1);
    for (const keyName of ['desk', 'laptop']) {
      const response = await api.request(`http://${REQUEST_HOST}${PHOTOS}`, {
        method: 'PUT',
        headers: { 'OCP-Admin-Key': keyName, 'OCP-Admin-Timestamp': String(NOW_SECONDS) },
        body: oversized,
      });
      expect(response.status).toBe(413);
    }
  });

  it('keeps 64 KiB for another method or another path ending in /places/photos', async () => {
    const api = build({ store: storeWithFremd() });
    const large = new Uint8Array(64 * 1024 + 1);
    const headers = { 'OCP-Admin-Key': 'desk', 'OCP-Admin-Timestamp': String(NOW_SECONDS) };
    for (const [method, path] of [
      ['DELETE', PHOTOS],
      ['PUT', '/admin/x/places/photos'],
      ['PUT', `${PHOTOS}/`],
    ] as const) {
      const response = await api.request(`http://${REQUEST_HOST}${path}`, {
        method,
        headers,
        body: large,
      });
      expect(response.status).toBe(413);
    }
  });

  it('accepts a photo upload signed exactly 60 seconds ago', async () => {
    const signed = bind(build({ store: storeWithFremd() }));
    const response = await signed('PUT', PHOTOS, upload([]), { timestamp: NOW_SECONDS - 60 });
    expect(response.status).toBe(200);
  });

  it('still checks the signature after the header check', async () => {
    const signed = bind(build({ store: storeWithFremd() }));
    const response = await signed('PUT', PHOTOS, upload([]), { host: REQUEST_HOST });
    await expectUnauthorized(response);
  });
});
