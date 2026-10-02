import { Hono } from 'hono';
import type { FetchLike } from '@/lib/map/btcmap';
import type { MapPlaceStore } from '@/lib/map/store';
import { healthRoutes } from '@/routes/health';
import { mapRoutes } from '@/routes/map';

export type AppDeps = {
  store: MapPlaceStore;
  /** Ingest bearer. Unset or blank means ingest is not configured. */
  ingestToken?: string;
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
};

/**
 * HTTP API. `GET /healthz` and `GET /map/places` are public.
 * `POST /map/places` creates a pin once. `PUT /map/places` updates a pin.
 * `DELETE /map/places` removes a pin.
 *
 * @param deps - Store, ingest token, and the BTC Map environment.
 * @returns The application.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route('/healthz', healthRoutes());
  app.route(
    '/map',
    mapRoutes({
      store: deps.store,
      env: deps.env,
      fetchImpl: deps.fetchImpl,
      ...(deps.ingestToken === undefined ? {} : { ingestToken: deps.ingestToken }),
    }),
  );
  return app;
}
