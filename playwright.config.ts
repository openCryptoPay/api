import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every run gets its own empty database; a reused file would keep rows from an
// older run. Workers load this config again, so the path travels in the env.
const dbPath =
  process.env['OCP_E2E_PLACE_DB'] ??
  join(tmpdir(), `opencryptopay-e2e-map-${String(process.pid)}-${String(Date.now())}.sqlite`);
process.env['OCP_E2E_PLACE_DB'] = dbPath;

/**
 * HTTP end-to-end tests against `bun src/index.ts`. No browser.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
  },
  webServer: {
    command: 'bun src/index.ts',
    url: 'http://127.0.0.1:3000/healthz',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
    env: {
      ...process.env,
      PORT: '3000',
      PLACE_DB: dbPath,
      OCP_PLACE_INGEST_TOKEN: 'e2e-ingest',
      BTCMAP_ACCESS_TOKEN: '',
      BTCMAP_SUBMIT_URL: '',
    },
  },
});
