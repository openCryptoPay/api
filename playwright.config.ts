import { defineConfig } from '@playwright/test';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every run gets its own empty database; a reused file would keep rows from an
// older run. Workers load this config again, so the path travels in the env.
const dbPath =
  process.env['OCP_E2E_PLACE_DB'] ??
  join(tmpdir(), `opencryptopay-e2e-map-${String(process.pid)}-${String(Date.now())}.sqlite`);
process.env['OCP_E2E_PLACE_DB'] = dbPath;

// One Ed25519 device for the run. Workers load this config again, so the PKCS8
// PEM travels in the env and every worker signs with the key the server trusts.
const adminPrivatePem =
  process.env['OCP_E2E_ADMIN_PRIVATE_KEY'] ??
  exportPkcs8(generateKeyPairSync('ed25519').privateKey);
process.env['OCP_E2E_ADMIN_PRIVATE_KEY'] = adminPrivatePem;
const adminPublicDer = Buffer.from(
  createPublicKey(createPrivateKey({ key: adminPrivatePem, format: 'pem', type: 'pkcs8' })).export({
    format: 'der',
    type: 'spki',
  }),
);
const adminPublicLine = `ed25519 ${adminPublicDer.subarray(12).toString('base64')} e2e`;

function exportPkcs8(key: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  const exported = key.export({ format: 'pem', type: 'pkcs8' });
  return typeof exported === 'string' ? exported : Buffer.from(exported).toString('utf8');
}

/**
 * HTTP end-to-end tests against `bun src/index.ts`. No browser.
 * Spec files share one server and database, so they run with one worker.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
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
      OCP_ADMIN_PUBLIC_KEYS: adminPublicLine,
      OCP_ADMIN_HOST: '127.0.0.1',
      BTCMAP_ACCESS_TOKEN: '',
      BTCMAP_SUBMIT_URL: '',
    },
  },
});
