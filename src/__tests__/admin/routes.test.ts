import { generateKeyPairSync } from 'node:crypto';
import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AdminPublicKey } from '@/lib/admin/keys';
import { signAdminRequest } from '@/lib/admin/signature';
import type { MapPlaceInput } from '@/lib/map/place';
import { MemoryMapPlaceStore } from '@/lib/map/store';
import { createApp } from '@/server';

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

const fremd: MapPlaceInput = { ...pin, origin: 'fremd', externalId: 'shop-9' };

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
    store.insertIfNew(pin);
    store.insertIfNew({ ...pin, externalId: 'blank', name: '' });
    const response = await bind(build({ store }))('GET', '/admin/places');
    expect(response.status).toBe(200);
    const listed = (await response.json()) as {
      places: Array<{ name: string; complete: boolean; problems: string[] }>;
    };
    const complete = listed.places.find((place) => place.name === pin.name);
    const incomplete = listed.places.find((place) => place.name === '');
    expect(complete).toMatchObject({ complete: true, problems: [] });
    expect(incomplete?.complete).toBe(false);
    expect(incomplete?.problems.length).toBeGreaterThan(0);
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
