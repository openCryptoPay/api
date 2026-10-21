import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AdminPublicKey } from '@/lib/admin/keys';
import { verifyAdminRequest, type AdminReplayCache } from '@/lib/admin/signature';
import type { FetchLike } from '@/lib/map/btcmap';
import { PLACE_ACTIVITIES as PLACE_ACTIVITY_VALUES } from '@/lib/map/filter-catalog';
import {
  normalizeExternalId,
  normalizeMapPlace,
  normalizePlaceOrigin,
  toPublicMapPlace,
  type MapPlaceInput,
  type PlaceActivity,
  type StoredMapPlace,
} from '@/lib/map/place';
import { npubEncode } from '@/lib/map/nostr-key';
import { placeProblems, type AdminActivityWrite, type MapPlaceStore } from '@/lib/map/store';
import { deletePlace, putPlace } from '@/routes/map';

export type AdminRouteDeps = {
  store: MapPlaceStore;
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  /** Allowed devices. Empty means admin is not configured. */
  keys: readonly AdminPublicKey[];
  /** Public host this instance answers as. Blank means admin is not configured. */
  host: string;
  now?: () => number;
  /** `OCP_PUBLIC_BASE_URL`, the origin of photo URLs in the list. */
  publicBaseUrl: string;
};

type AdminEnv = {
  Variables: {
    rawBody: Uint8Array;
  };
};

const MAX_ADMIN_BODY_BYTES = 64 * 1024;
const FOUR_DIGIT_YEAR = /^\d{4}-/u;
const PLACE_ACTIVITIES: ReadonlySet<string> = new Set(PLACE_ACTIVITY_VALUES);

function pathWithQuery(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.pathname}${url.search}`;
}

function parseJsonBody(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

type ParsedPlaceId =
  | { kind: 'absent' }
  | { kind: 'invalid'; error: string }
  | { kind: 'id'; id: string; body: Record<string, unknown> };

/**
 * Read an own property `id` without trimming a non-empty value.
 * A non-object has no id. A blank or non-string id, or an npub, is invalid:
 * admin writes address the internal id that `GET /admin/places` returns.
 *
 * @param raw - Parsed JSON.
 * @returns Whether `id` is absent, invalid, or an internal id.
 */
function parsePlaceId(raw: unknown): ParsedPlaceId {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'absent' };
  }
  const body = raw as Record<string, unknown>;
  if (!Object.hasOwn(body, 'id')) {
    return { kind: 'absent' };
  }
  const id = body['id'];
  if (typeof id !== 'string' || id.trim() === '') {
    return { kind: 'invalid', error: 'Place id is required' };
  }
  if (id.startsWith('npub1')) {
    return { kind: 'invalid', error: 'Place id is the internal id, not the npub' };
  }
  return { kind: 'id', id, body };
}

/**
 * Check a present origin, then a present external id, against the stored row.
 * Omitted fields stay stored.
 *
 * @param body - JSON object that includes `id`.
 * @param stored - The row addressed by that id.
 * @returns The first error, or undefined when both present fields name this row.
 */
function storedIdentityError(
  body: Record<string, unknown>,
  stored: StoredMapPlace,
): string | undefined {
  if (Object.hasOwn(body, 'origin')) {
    const origin = normalizePlaceOrigin(body['origin']);
    if (!origin.ok) {
      return origin.error;
    }
    if (origin.value !== stored.origin) {
      return 'Place origin does not match';
    }
  }
  if (Object.hasOwn(body, 'externalId')) {
    const externalId = normalizeExternalId(body['externalId']);
    if (!externalId.ok) {
      return externalId.error;
    }
    if (externalId.value !== stored.externalId) {
      return 'Place external id does not match';
    }
  }
  return undefined;
}

/**
 * Resolve origin, then external id, for an internal-id replace.
 * A present field is normalized. A different valid value is kept. An omitted field stays stored.
 *
 * @param body - JSON object that includes `id`.
 * @param stored - The row addressed by that id.
 * @returns The pair to write, or the first normalizer error.
 */
function resolveAdminPlaceIdentity(
  body: Record<string, unknown>,
  stored: StoredMapPlace,
): { ok: true; origin: string; externalId: string } | { ok: false; error: string } {
  let origin = stored.origin;
  if (Object.hasOwn(body, 'origin')) {
    const parsed = normalizePlaceOrigin(body['origin']);
    if (!parsed.ok) {
      return parsed;
    }
    origin = parsed.value;
  }
  let externalId = stored.externalId;
  if (Object.hasOwn(body, 'externalId')) {
    const parsed = normalizeExternalId(body['externalId']);
    if (!parsed.ok) {
      return parsed;
    }
    externalId = parsed.value;
  }
  return { ok: true, origin, externalId };
}

/**
 * Canonical ISO instant with a four-digit year.
 *
 * @param raw - JSON value.
 * @returns The canonical instant, or undefined when the value is not one.
 */
function canonicalAdminInstant(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const canonical = new Date(parsed).toISOString();
  if (!FOUR_DIGIT_YEAR.test(canonical)) {
    return undefined;
  }
  return canonical;
}

/**
 * Accept only an exact activity token. Surrounding space is rejected.
 *
 * @param raw - JSON value.
 * @returns Whether `raw` is a stored activity token.
 */
function isPlaceActivity(raw: unknown): raw is PlaceActivity {
  return typeof raw === 'string' && PLACE_ACTIVITIES.has(raw);
}

/**
 * Copy a place body for `normalizeMapPlace`.
 * Drops the internal id, `createdAt`, `lastTransactionAt`, `activity`, and `active`, sets the resolved pair, and
 * fills in the stored key when the body leaves it out.
 *
 * @param body - JSON object that includes `id`.
 * @param origin - Normalized origin to store.
 * @param externalId - Normalized caller id to store.
 * @param storedKey - The row's stored key, or null.
 * @returns The body the place validator accepts.
 */
function adminReplaceBody(
  body: Record<string, unknown>,
  origin: string,
  externalId: string,
  storedKey: string | null,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...body };
  if (!Object.hasOwn(copy, 'nostrPubkey') && storedKey !== null) {
    copy['nostrPubkey'] = storedKey;
  }
  delete copy['id'];
  delete copy['createdAt'];
  delete copy['lastTransactionAt'];
  delete copy['activity'];
  delete copy['active'];
  copy['origin'] = origin;
  copy['externalId'] = externalId;
  return copy;
}

/**
 * Signed admin maintenance for any origin. Mounted at `/admin`.
 * The signature uses the configured host, never the request Host header.
 * The body is read once and then parsed as JSON for PUT and DELETE.
 * Bodies above 64 KiB answer 413 before the signature is checked.
 * GET returns the public place with the internal id as `id` and the public id
 * as `npub`, and adds the caller id, payment methods, created time, last
 * transaction time, and `active`. It does not add the refresh deadline or payment days.
 * A JSON object with an own property `id` addresses that internal id; an npub is rejected.
 * PUT with `id` replaces that row, including a new origin and caller id, and does not call BTC Map.
 * It keeps a stored key, stores a sent key on a row without one (R7, checked against the new
 * pair), moves the key reservation with the row, and does not take a `revision` (R8).
 * A present `active` must be a JSON boolean. Anything else is `Place active is invalid`
 * and writes nothing. A body whose only own properties are `id` and that boolean stores
 * the flag on the stored fields, so a shop with no key can be hidden without inventing
 * one, and does not call `normalizeMapPlace`. Omitted `active` keeps the stored flag.
 * The body copy drops `active` before `normalizeMapPlace`.
 * DELETE with `id` still rejects a different origin or caller id and needs no revision.
 * Without `id`, PUT and DELETE keep the origin and external id paths with the source rules.
 *
 * @param deps - Store, BTC Map environment, allowed keys, configured host, the public base URL
 * of photo URLs, and an optional clock.
 * @returns The admin route group.
 */
export function adminRoutes(deps: AdminRouteDeps): Hono<AdminEnv> {
  const now = deps.now ?? (() => Date.now());
  const replay: AdminReplayCache = new Map();
  const host = deps.host.trim();
  const configured = deps.keys.length > 0 && host !== '';
  const app = new Hono<AdminEnv>();

  app.use('*', async (c, next) => {
    if (!configured) {
      return c.json({ error: 'Admin is not configured' }, 503);
    }
    await next();
  });

  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_ADMIN_BODY_BYTES,
      onError: (c) => c.json({ error: 'Payload too large' }, 413),
    }),
  );

  app.use('*', async (c, next) => {
    const rawBody = new Uint8Array(await c.req.arrayBuffer());
    const accepted = verifyAdminRequest({
      keys: deps.keys,
      keyName: c.req.header('OCP-Admin-Key'),
      timestamp: c.req.header('OCP-Admin-Timestamp'),
      nonce: c.req.header('OCP-Admin-Nonce'),
      signature: c.req.header('OCP-Admin-Signature'),
      method: c.req.method,
      host,
      pathWithQuery: pathWithQuery(c.req.url),
      body: rawBody,
      nowSeconds: Math.floor(now() / 1000),
      replay,
    });
    if (!accepted) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    c.set('rawBody', rawBody);
    await next();
  });

  app.get('/places', (c) => {
    const places = deps.store.listAll().map((place) => {
      const problems = placeProblems(place);
      const publicPlace = toPublicMapPlace(place, deps.publicBaseUrl);
      return {
        ...publicPlace,
        id: place.id,
        npub: publicPlace.id,
        complete: problems.length === 0,
        problems,
        externalId: place.externalId,
        paymentMethods: place.paymentMethods,
        createdAt: place.createdAt,
        lastTransactionAt: place.lastTransactionAt,
        active: place.active,
      };
    });
    return c.json({ places });
  });

  app.put('/places', async (c) => {
    const raw = parseJsonBody(c.get('rawBody'));
    const parsedId = parsePlaceId(raw);
    if (parsedId.kind === 'invalid') {
      return c.json({ error: parsedId.error }, 400);
    }
    if (parsedId.kind === 'absent') {
      const result = await putPlace(
        { store: deps.store, env: deps.env, fetchImpl: deps.fetchImpl },
        raw,
      );
      return c.json(result.body, result.status);
    }
    if (Object.hasOwn(parsedId.body, 'revision')) {
      return c.json({ error: 'Place field is not allowed: revision' }, 400);
    }
    const stored = deps.store.getById(parsedId.id);
    if (stored === undefined) {
      return c.json({ error: 'Place not found' }, 404);
    }
    const identity = resolveAdminPlaceIdentity(parsedId.body, stored);
    if (!identity.ok) {
      return c.json({ error: identity.error }, 400);
    }
    let createdAt = stored.createdAt;
    if (Object.hasOwn(parsedId.body, 'createdAt')) {
      const canonical = canonicalAdminInstant(parsedId.body['createdAt']);
      if (canonical === undefined) {
        return c.json({ error: 'Place created time is invalid' }, 400);
      }
      createdAt = canonical;
    }
    let lastTransactionAt = stored.lastTransactionAt;
    const lastTransactionPresent = Object.hasOwn(parsedId.body, 'lastTransactionAt');
    if (lastTransactionPresent) {
      const rawLast = parsedId.body['lastTransactionAt'];
      if (rawLast === null) {
        lastTransactionAt = null;
      } else {
        const canonical = canonicalAdminInstant(rawLast);
        if (canonical === undefined) {
          return c.json({ error: 'Place transaction time is invalid' }, 400);
        }
        lastTransactionAt = canonical;
      }
    }
    const activityPresent = Object.hasOwn(parsedId.body, 'activity');
    let activityWrite: AdminActivityWrite;
    if (activityPresent) {
      const activity = parsedId.body['activity'];
      if (!isPlaceActivity(activity)) {
        return c.json({ error: 'Place activity is invalid' }, 400);
      }
      activityWrite = { kind: 'set', activity };
    } else if (lastTransactionPresent) {
      activityWrite = { kind: 'recompute' };
    } else {
      activityWrite = { kind: 'keep' };
    }
    let active = stored.active;
    if (Object.hasOwn(parsedId.body, 'active')) {
      const value = parsedId.body['active'];
      if (typeof value !== 'boolean') {
        return c.json({ error: 'Place active is invalid' }, 400);
      }
      active = value;
    }
    // A stored shop with no key can be hidden without inventing a key.
    const flagOnly =
      Object.keys(parsedId.body).length === 2 &&
      Object.hasOwn(parsedId.body, 'id') &&
      Object.hasOwn(parsedId.body, 'active');
    let content: MapPlaceInput;
    if (flagOnly) {
      content = {
        origin: stored.origin,
        externalId: stored.externalId,
        name: stored.name,
        description: stored.description,
        lat: stored.lat,
        lon: stored.lon,
        category: stored.category,
        paymentMethods: stored.paymentMethods,
        techProvider: stored.techProvider,
        shopType: stored.shopType,
        street: stored.street,
        houseNumber: stored.houseNumber,
        postalCode: stored.postalCode,
        city: stored.city,
        country: stored.country,
        supports: stored.supports,
      };
      if (stored.nostrPubkey !== null) {
        content.nostrPubkey = stored.nostrPubkey;
      }
    } else {
      const parsed = normalizeMapPlace(
        adminReplaceBody(parsedId.body, identity.origin, identity.externalId, stored.nostrPubkey),
      );
      if (!parsed.ok) {
        return c.json({ error: parsed.error }, 400);
      }
      content = parsed.value;
    }
    const replaced = deps.store.replaceById({
      id: parsedId.id,
      content,
      createdAt: flagOnly ? stored.createdAt : createdAt,
      lastTransactionAt: flagOnly ? stored.lastTransactionAt : lastTransactionAt,
      activity: flagOnly ? { kind: 'keep' } : activityWrite,
      active,
      nowMs: now(),
    });
    if (replaced.status === 'missing') {
      return c.json({ error: 'Place not found' }, 404);
    }
    if (replaced.status === 'conflict') {
      return c.json({ error: 'Place already exists' }, 409);
    }
    if (replaced.status === 'keyConflict') {
      return c.json({ error: replaced.error }, 409);
    }
    const key = replaced.place.nostrPubkey;
    const npub = key === null ? null : npubEncode(key);
    return c.json({ created: false, id: replaced.place.id, npub, btcmap: 'skipped' }, 200);
  });

  app.delete('/places', (c) => {
    const raw = parseJsonBody(c.get('rawBody'));
    const parsedId = parsePlaceId(raw);
    if (parsedId.kind === 'invalid') {
      return c.json({ error: parsedId.error }, 400);
    }
    if (parsedId.kind === 'absent') {
      const result = deletePlace({ store: deps.store }, raw);
      return c.json(result.body, result.status);
    }
    if (Object.hasOwn(parsedId.body, 'revision')) {
      return c.json({ error: 'Place field is not allowed: revision' }, 400);
    }
    const stored = deps.store.getById(parsedId.id);
    if (stored === undefined) {
      return c.json({ deleted: false }, 200);
    }
    const identityError = storedIdentityError(parsedId.body, stored);
    if (identityError !== undefined) {
      return c.json({ error: identityError }, 400);
    }
    const deleted = deps.store.deleteById(parsedId.id);
    return c.json({ deleted }, 200);
  });

  return app;
}
