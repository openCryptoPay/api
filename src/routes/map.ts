import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { pushMapPlace, type FetchLike, type MapPushResult } from '@/lib/map/btcmap';
import { publicFilterResponse } from '@/lib/map/filter-catalog';
import { isNostrPubkey, npubDecode, npubEncode } from '@/lib/map/nostr-key';
import {
  MAX_PHOTO_BODY_BYTES,
  normalizePhotoUpload,
  preparePhoto,
  type PreparedPhoto,
} from '@/lib/map/photo';
import { photoExtension } from '@/lib/map/photo-strip';
import {
  normalizeMapPlace,
  normalizeMapPlaceDelete,
  normalizeMapPlaceFilter,
  normalizePlaceOrigin,
  normalizePlaceTransaction,
  publicPhoto,
  toPublicMapPlace,
  toPublicMapPlaceDetail,
} from '@/lib/map/place';
import type {
  MapPhotoFile,
  MapPlaceListFilter,
  MapPlaceStore,
  MapPlaceWriteError,
} from '@/lib/map/store';

/** Cache rule of `GET /map/places/{npub}` on 200, 301 and 404. */
const DETAIL_CACHE = 'public, max-age=60';

/** Cache rule of a served photo: its URL names its bytes. */
const PHOTO_CACHE = 'public, max-age=31536000, immutable';

const PHOTO_FILE = /^([0-9a-f]{64})\.(jpg|png|webp)$/u;

export type MapRouteDeps = {
  store: MapPlaceStore;
  /** Ingest bearer. Unset or blank means ingest is not configured. */
  ingestToken?: string;
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  now?: () => number;
  /** `OCP_PUBLIC_BASE_URL`, the origin of every photo URL. */
  publicBaseUrl: string;
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
 * An own property `id` is rejected and nothing is written.
 *
 * @param deps - Store, BTC Map environment, and fetch.
 * @param raw - Request JSON, or null when the body is not JSON.
 * @returns 400 with the validator message, 409 for a stale revision or a key
 * conflict (R7, R8), 201 when inserted, or 200 when replaced. `id` is the npub
 * of the key the body carries.
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
  | { status: 409; body: { error: MapPlaceWriteError } }
  | { status: 200 | 201; body: { created: boolean; id: string; btcmap: MapPushResult } }
> {
  const parsed = normalizeMapPlace(raw);
  if (!parsed.ok) {
    return { status: 400, body: { error: parsed.error } };
  }
  const result = deps.store.upsert(parsed.value, parsed.revision);
  if (!result.ok) {
    return { status: 409, body: { error: result.error } };
  }
  const { created, place } = result;
  let btcmap: MapPushResult = 'skipped';
  if (created) {
    btcmap = await pushMapPlace(place, deps.env, deps.fetchImpl);
  }
  // A write carries a key (step 1b) and the store refuses a different one, so it is the row's key.
  const id = npubEncode(parsed.value.nostrPubkey);
  return { status: created ? 201 : 200, body: { created, id, btcmap } };
}

/**
 * Remove one map pin by origin and external id.
 * Same validation as `DELETE /map/places`: exactly `origin`, `externalId` and an
 * optional `revision`; any other field, `id` included, is rejected and nothing is
 * deleted. A missing pair is `{ deleted: false }`.
 *
 * @param deps - Store.
 * @param raw - Request JSON, or null when the body is not JSON.
 * @returns 400 with the validator message, 409 `Stale revision` (R8), or 200 `{ deleted }`.
 */
export function deletePlace(
  deps: { store: MapPlaceStore },
  raw: unknown,
):
  | { status: 400; body: { error: string } }
  | { status: 409; body: { error: 'Stale revision' } }
  | { status: 200; body: { deleted: boolean } } {
  const parsed = normalizeMapPlaceDelete(raw);
  if (!parsed.ok) {
    return { status: 400, body: { error: parsed.error } };
  }
  const result = deps.store.deleteByKey(
    parsed.value.origin,
    parsed.value.externalId,
    parsed.revision,
  );
  if (!result.ok) {
    return { status: 409, body: { error: result.error } };
  }
  return { status: 200, body: { deleted: result.deleted } };
}

/**
 * Replace every photo of one shop.
 * Same envelope, photo checks, and store write as `PUT /map/places/photos`: a photo that
 * breaks a rule is skipped and reported, and the others are stored in their order.
 *
 * @param deps - Store and the public base URL of photo URLs.
 * @param raw - Request JSON, or null when the body is not JSON.
 * @returns 400 with the envelope message, 404 `Place not found`, 409 `Stale revision` (R8),
 * or 200 with the stored photos and the skipped ones.
 */
export function replacePlacePhotos(
  deps: { store: MapPlaceStore; publicBaseUrl: string },
  raw: unknown,
):
  | { status: 400; body: { error: string } }
  | { status: 404; body: { error: 'Place not found' } }
  | { status: 409; body: { error: 'Stale revision' } }
  | {
      status: 200;
      body: {
        photos: ReturnType<typeof publicPhoto>[];
        skipped: Array<{ index: number; error: string }>;
      };
    } {
  const parsed = normalizePhotoUpload(raw);
  if (!parsed.ok) {
    return { status: 400, body: { error: parsed.error } };
  }
  const prepared: PreparedPhoto[] = [];
  const skipped: Array<{ index: number; error: string }> = [];
  for (const [index, entry] of parsed.value.photos.entries()) {
    const photo = preparePhoto(entry, index);
    if (photo.ok) {
      prepared.push(photo.photo);
    } else {
      skipped.push({ index, error: photo.error });
    }
  }
  const result = deps.store.replacePhotos(
    parsed.value.origin,
    parsed.value.nostrPubkey,
    prepared,
    parsed.value.revision,
  );
  if (!result.ok) {
    return result.error === 'Place not found'
      ? { status: 404, body: { error: result.error } }
      : { status: 409, body: { error: result.error } };
  }
  const photos = result.photos.map((photo) => publicPhoto(photo, deps.publicBaseUrl));
  return { status: 200, body: { photos, skipped } };
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
    const places = deps.store
      .list(limit, filter)
      .map((place) => toPublicMapPlace(place, deps.publicBaseUrl));
    return c.json({ places });
  });

  app.get('/places/:id', (c) => {
    const segment = c.req.param('id');
    const fromNpub = npubDecode(segment);
    const pubkey = fromNpub ?? (isNostrPubkey(segment) ? segment : null);
    try {
      const place = pubkey === null ? undefined : deps.store.findPublicByPubkey(pubkey);
      c.header('Cache-Control', DETAIL_CACHE);
      if (place === undefined) {
        return c.json({ error: 'Place not found' }, 404);
      }
      if (fromNpub === null) {
        return c.redirect(`/map/places/${npubEncode(segment)}`, 301);
      }
      return c.json({ place: toPublicMapPlaceDetail(place, deps.publicBaseUrl) });
    } catch {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'Places are unavailable' }, 503);
    }
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
    const result = deps.store.insertIfNew(parsed.value, parsed.revision);
    if (!result.ok) {
      return c.json({ error: result.error }, 409);
    }
    const { created, place } = result;
    let btcmap: MapPushResult = 'skipped';
    if (created) {
      btcmap = await pushMapPlace(place, deps.env, deps.fetchImpl);
    }
    const id = npubEncode(parsed.value.nostrPubkey);
    return c.json({ created, id, btcmap }, created ? 201 : 200);
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

  const requireIngest = async (c: Context, next: Next): Promise<Response | void> => {
    const auth = checkIngest(deps.ingestToken, c.req.header('authorization'));
    if (auth === 'unconfigured') {
      return c.json({ error: 'Place ingest is not configured' }, 503);
    }
    if (auth === 'unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  };

  /** Runs after `requireIngest`, so 503 and 401 come before 413. */
  const photoBodyLimit = bodyLimit({
    maxSize: MAX_PHOTO_BODY_BYTES,
    onError: (c) => c.json({ error: 'Payload too large' }, 413),
  });

  app.put('/places/photos', requireIngest, photoBodyLimit, async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const result = replacePlacePhotos(
      { store: deps.store, publicBaseUrl: deps.publicBaseUrl },
      raw,
    );
    return c.json(result.body, result.status);
  });

  app.get('/photos/:file', (c) => {
    const match = PHOTO_FILE.exec(c.req.param('file'));
    const notFound = (): Response => {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'Photo not found' }, 404);
    };
    if (match === null) {
      return notFound();
    }
    let file: MapPhotoFile | undefined;
    try {
      file = deps.store.findPublicPhoto(match[1] as string);
    } catch {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'Places are unavailable' }, 503);
    }
    if (file === undefined || photoExtension(file.contentType) !== match[2]) {
      return notFound();
    }
    return c.body(new Uint8Array(file.data).buffer, 200, {
      'Content-Type': file.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': PHOTO_CACHE,
    });
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
