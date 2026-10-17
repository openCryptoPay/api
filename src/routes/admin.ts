import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AdminPublicKey } from '@/lib/admin/keys';
import { verifyAdminRequest, type AdminReplayCache } from '@/lib/admin/signature';
import type { FetchLike } from '@/lib/map/btcmap';
import { toPublicMapPlace } from '@/lib/map/place';
import { placeProblems, type MapPlaceStore } from '@/lib/map/store';
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
};

type AdminEnv = {
  Variables: {
    rawBody: Uint8Array;
  };
};

const MAX_ADMIN_BODY_BYTES = 64 * 1024;

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

/**
 * Signed admin maintenance for any origin. Mounted at `/admin`.
 * The signature uses the configured host, never the request Host header.
 * The body is read once and then parsed as JSON for PUT and DELETE.
 * Bodies above 64 KiB answer 413 before the signature is checked.
 *
 * @param deps - Store, BTC Map environment, allowed keys, configured host, and an optional clock.
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
      return {
        ...toPublicMapPlace(place),
        complete: problems.length === 0,
        problems,
      };
    });
    return c.json({ places });
  });

  app.put('/places', async (c) => {
    const result = await putPlace(
      { store: deps.store, env: deps.env, fetchImpl: deps.fetchImpl },
      parseJsonBody(c.get('rawBody')),
    );
    return c.json(result.body, result.status);
  });

  app.delete('/places', (c) => {
    const result = deletePlace({ store: deps.store }, parseJsonBody(c.get('rawBody')));
    return c.json(result.body, result.status);
  });

  return app;
}
