import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseAdminPublicKeys } from '@/lib/admin/keys';
import { SqliteMapPlaceStore } from '@/lib/map/sqlite';
import { createApp } from '@/server';

const filename = process.env['PLACE_DB']?.trim() || 'data/places.sqlite';
if (filename !== ':memory:') {
  mkdirSync(dirname(filename), { recursive: true });
}

const store = new SqliteMapPlaceStore(filename);
store.refreshActivity(Date.now());
setInterval(() => {
  store.refreshActivity(Date.now());
}, 1000);
const parsedPort = Number(process.env['PORT'] ?? '3000');
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
const token = process.env['OCP_PLACE_INGEST_TOKEN'];
const adminKeysRaw = process.env['OCP_ADMIN_PUBLIC_KEYS'];
const adminHost = (process.env['OCP_ADMIN_HOST'] ?? '').trim().toLowerCase();
const adminKeys =
  adminKeysRaw === undefined || adminKeysRaw.trim() === ''
    ? []
    : parseAdminPublicKeys(adminKeysRaw);

const app = createApp({
  store,
  env: process.env,
  fetchImpl: (input, init) => globalThis.fetch(input, init),
  adminKeys,
  adminHost,
  ...(token === undefined ? {} : { ingestToken: token }),
});

Bun.serve({
  hostname: '0.0.0.0',
  port,
  fetch: app.fetch,
});
