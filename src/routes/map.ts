import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { pushMapPlace, type FetchLike, type MapPushResult } from '@/lib/map/btcmap';
import { normalizeMapPlace, normalizeMapPlaceKey, toPublicMapPlace } from '@/lib/map/place';
import type { MapPlaceStore } from '@/lib/map/store';

export type MapRouteDeps = {
  store: MapPlaceStore;
  /** Ingest bearer. Unset or blank means ingest is not configured. */
  ingestToken?: string;
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
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
 * Public map list and ingest. Mounted at `/map`.
 *
 * @param deps - Store, ingest token, and the environment used for BTC Map.
 * @returns The map route group.
 */
export function mapRoutes(deps: MapRouteDeps): Hono {
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
    const places = deps.store.list(limit).map((place) => toPublicMapPlace(place));
    return c.json({ places });
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
    const parsed = normalizeMapPlace(raw);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }
    const { created, place } = deps.store.upsert(parsed.value);
    let btcmap: MapPushResult = 'skipped';
    if (created) {
      btcmap = await pushMapPlace(place, deps.env, deps.fetchImpl);
    }
    return c.json({ created, id: place.id, btcmap }, created ? 201 : 200);
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
    const parsed = normalizeMapPlaceKey(raw);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }
    const deleted = deps.store.deleteByKey(parsed.value.origin, parsed.value.externalId);
    return c.json({ deleted });
  });

  return app;
}
