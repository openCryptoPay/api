import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { pushMapPlace, type FetchLike, type MapPushResult } from '@/lib/map/btcmap';
import { publicFilterResponse } from '@/lib/map/filter-catalog';
import {
  normalizeMapPlace,
  normalizeMapPlaceFilter,
  normalizeMapPlaceKey,
  normalizePlaceOrigin,
  normalizePlaceTransaction,
  toPublicMapPlace,
} from '@/lib/map/place';
import type { MapPlaceListFilter, MapPlaceStore } from '@/lib/map/store';

export type MapRouteDeps = {
  store: MapPlaceStore;
  /** Ingest bearer. Unset or blank means ingest is not configured. */
  ingestToken?: string;
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  now?: () => number;
};

function checkIngest(
  configured: string | undefined,
  authorization: string | undefined,
): 'unconfigured' | 'unauthorized' | 'ok' {
  if (configured === undefined || configured.trim() === '') {
    return 'unconfigured';
  }
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    return 'unauthorized';
  }
  const presented = authorization.slice('Bearer '.length).trim();
  const expected = configured.trim();
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return 'unauthorized';
  }
  return 'ok';
}

/**
 * Full replace of one map pin, or insert it when the origin and external id are new.
 * Same validation, store write, and BTC Map call as `PUT /map/places`.
 *
 * @param deps - Store, BTC Map environment, and fetch.
 * @param raw - Request JSON, or null when the body is not JSON.
 * @returns 400 with the validator message, 201 when inserted, or 200 when replaced.
 */
export async function putPlace(
  deps: {
    store: MapPlaceStore;
    env: Record<string, string | undefined>;
    fetchImpl: FetchLike;
  },
  raw: unknown,
): Promise<
  | { status: 400; body: { error: string } }
  | { status: 200 | 201; body: { created: boolean; id: string; btcmap: MapPushResult } }
> {
  const parsed = normalizeMapPlace(raw);
  if (!parsed.ok) {
    return { status: 400, body: { error: parsed.error } };
  }
  const { created, place } = deps.store.upsert(parsed.value);
  let btcmap: MapPushResult = 'skipped';
  if (created) {
    btcmap = await pushMapPlace(place, deps.env, deps.fetchImpl);
  }
  return { status: created ? 201 : 200, body: { created, id: place.id, btcmap } };
}

/**
 * Remove one map pin by origin and external id.
 * Same validation as `DELETE /map/places`. A missing pair is `{ deleted: false }`.
 *
 * @param deps - Store.
 * @param raw - Request JSON, or null when the body is not JSON.
 * @returns 400 with the validator message, or 200 `{ deleted }`.
 */
export function deletePlace(
  deps: { store: MapPlaceStore },
  raw: unknown,
): { status: 400; body: { error: string } } | { status: 200; body: { deleted: boolean } } {
  const parsed = normalizeMapPlaceKey(raw);
  if (!parsed.ok) {
    return { status: 400, body: { error: parsed.error } };
  }
  const deleted = deps.store.deleteByKey(parsed.value.origin, parsed.value.externalId);
  return { status: 200, body: { deleted } };
}

/**
 * Public map list and ingest. Mounted at `/map`.
 *
 * @param deps - Store, ingest token, BTC Map environment, and an optional clock.
 * @returns The map route group.
 */
export function mapRoutes(deps: MapRouteDeps): Hono {
  const now = deps.now ?? (() => Date.now());
  const app = new Hono();
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'OPTIONS'],
    }),
  );

  app.get('/places', (c) => {
    const limitQuery = c.req.query('limit');
    let limit = 1000;
    if (limitQuery !== undefined) {
      if (!/^\d+$/.test(limitQuery)) {
        return c.json({ error: 'Invalid limit' }, 400);
      }
      const n = Number(limitQuery);
      if (n < 1 || n > 1000) {
        return c.json({ error: 'Invalid limit' }, 400);
      }
      limit = n;
    }
    const originQuery = c.req.query('origin');
    let origin: string | undefined;
    if (originQuery !== undefined) {
      const parsedOrigin = normalizePlaceOrigin(originQuery);
      if (!parsedOrigin.ok) {
        return c.json({ error: parsedOrigin.error }, 400);
      }
      origin = parsedOrigin.value;
    }
    const parsedFilter = normalizeMapPlaceFilter(
      c.req.query('country'),
      c.req.query('shopType'),
      c.req.query('shopName'),
      c.req.query('blockchain'),
      c.req.query('asset'),
    );
    if (!parsedFilter.ok) {
      return c.json({ error: parsedFilter.error }, 400);
    }
    const filter: MapPlaceListFilter = { ...parsedFilter.value };
    if (origin !== undefined) {
      filter.origin = origin;
    }
    const places = deps.store.list(limit, filter).map((place) => toPublicMapPlace(place));
    return c.json({ places });
  });

  app.get('/filters', (c) => {
    const parsed = normalizeMapPlaceFilter(
      undefined,
      undefined,
      undefined,
      c.req.query('blockchain'),
      undefined,
    );
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }
    const values = deps.store.filters(parsed.value.blockchain);
    return c.json(publicFilterResponse(values, parsed.value.blockchain));
  });

  app.post('/places', async (c) => {
    const auth = checkIngest(deps.ingestToken, c.req.header('authorization'));
    if (auth === 'unconfigured') {
      return c.json({ error: 'Place ingest is not configured' }, 503);
    }
    if (auth === 'unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = normalizeMapPlace(raw);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }
    const { created, place } = deps.store.insertIfNew(parsed.value);
    let btcmap: MapPushResult = 'skipped';
    if (created) {
      btcmap = await pushMapPlace(place, deps.env, deps.fetchImpl);
    }
    return c.json({ created, id: place.id, btcmap }, created ? 201 : 200);
  });

  app.put('/places', async (c) => {
    const auth = checkIngest(deps.ingestToken, c.req.header('authorization'));
    if (auth === 'unconfigured') {
      return c.json({ error: 'Place ingest is not configured' }, 503);
    }
    if (auth === 'unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw: unknown = await c.req.json().catch(() => null);
    const result = await putPlace(deps, raw);
    return c.json(result.body, result.status);
  });

  app.delete('/places', async (c) => {
    const auth = checkIngest(deps.ingestToken, c.req.header('authorization'));
    if (auth === 'unconfigured') {
      return c.json({ error: 'Place ingest is not configured' }, 503);
    }
    if (auth === 'unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw: unknown = await c.req.json().catch(() => null);
    const result = deletePlace(deps, raw);
    return c.json(result.body, result.status);
  });

  app.post('/places/transactions', async (c) => {
    const auth = checkIngest(deps.ingestToken, c.req.header('authorization'));
    if (auth === 'unconfigured') {
      return c.json({ error: 'Place ingest is not configured' }, 503);
    }
    if (auth === 'unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const nowMs = now();
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = normalizePlaceTransaction(raw, nowMs);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }
    const place = deps.store.recordTransaction(
      parsed.value.origin,
      parsed.value.externalId,
      parsed.value.occurredAt,
      nowMs,
    );
    if (place === undefined) {
      return c.json({ error: 'Place not found' }, 404);
    }
    return c.json({ activity: place.activity });
  });

  return app;
}
