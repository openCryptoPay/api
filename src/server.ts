import { Hono } from 'hono';
import type { AdminPublicKey } from '@/lib/admin/keys';
import type { FetchLike } from '@/lib/map/btcmap';
import type { MapPlaceStore } from '@/lib/map/store';
import { adminRoutes } from '@/routes/admin';
import { healthRoutes } from '@/routes/health';
import { mapRoutes } from '@/routes/map';
import { welcomeRoutes } from '@/routes/welcome';

export type AppDeps = {
  store: MapPlaceStore;
  /** Ingest bearer. Unset or blank means ingest is not configured. */
  ingestToken?: string;
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  /** Request clock. Unset means `Date.now`. */
  now?: () => number;
  /** Allowed admin devices. Empty or omitted disables `/admin`. */
  adminKeys?: readonly AdminPublicKey[];
  /** Public host this instance answers as. Blank or omitted disables `/admin`. */
  adminHost?: string;
};

/**
 * HTTP API. `GET /` is the welcome page. `GET /healthz`, `GET /map/places`, and
 * `GET /map/filters` are public.
 * `POST /map/places` creates a pin once. `PUT /map/places` updates a pin.
 * `DELETE /map/places` removes a pin.
 * `/admin` maintains places with a per-device signature. It answers 503 when
 * admin keys or the admin host are missing.
 *
 * @param deps - Store, ingest token, admin keys and host, the BTC Map environment, and an optional clock.
 * @returns The application.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route('/', welcomeRoutes());
  app.route('/healthz', healthRoutes());
  app.route(
    '/map',
    mapRoutes({
      store: deps.store,
      env: deps.env,
      fetchImpl: deps.fetchImpl,
      ...(deps.ingestToken === undefined ? {} : { ingestToken: deps.ingestToken }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  );
  app.route(
    '/admin',
    adminRoutes({
      store: deps.store,
      env: deps.env,
      fetchImpl: deps.fetchImpl,
      keys: deps.adminKeys ?? [],
      host: deps.adminHost ?? '',
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  );
  return app;
}
