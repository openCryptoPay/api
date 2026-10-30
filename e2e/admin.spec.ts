import { execFileSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { canonicalString, signAdminRequest } from '../src/lib/admin/signature';
import { isNostrPubkey, npubEncode } from '../src/lib/map/nostr-key';
import { base64, simplePng } from '../src/__tests__/map/photo-fixtures';

/** A valid NIP-01 key derived from a label, so each test shop has its own. */
function keyFor(label: string): string {
  for (let round = 0; ; round += 1) {
    const candidate = createHash('sha256')
      .update(`${label}:${String(round)}`)
      .digest('hex');
    if (isNostrPubkey(candidate)) {
      return candidate;
    }
  }
}

const DESCRIPTION =
  'SPAR supermarket in Triesen. Customers can pay with Bitcoin and other crypto assets through OpenCryptoPay at the checkout.';

const HOST = '127.0.0.1';
const PATH = '/admin/places';
const KEY_NAME = 'e2e';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const fremd = {
  origin: 'fremd',
  externalId: 'e2e-admin-fremd',
  name: 'Fremde Filiale',
  description: DESCRIPTION,
  lat: 47.37,
  lon: 8.54,
  category: 'groceries',
  paymentMethods: 'lightning',
  shopType: 'SPAR',
  street: 'Maschlinastrasse',
  houseNumber: '4',
  postalCode: '9495',
  city: 'Triesen',
  country: 'LI',
  nostrPubkey: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
};

let replay:
  | {
      headers: Record<string, string>;
      body: string;
    }
  | undefined;

function privateKey(): KeyObject {
  const pem = process.env['OCP_E2E_ADMIN_PRIVATE_KEY'];
  if (pem === undefined || pem === '') {
    throw new Error('OCP_E2E_ADMIN_PRIVATE_KEY is missing');
  }
  return createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
}

type AdminListedPlace = {
  id: string;
  npub: string | null;
  origin: string;
  name: string;
  externalId: string;
  paymentMethods: string | null;
  createdAt: string;
  lastTransactionAt: string | null;
  activity: string;
  active: boolean;
  complete: boolean;
};

async function listedPlace(
  request: APIRequestContext,
  externalId: string,
): Promise<AdminListedPlace> {
  const res = await request.get('/admin/places', {
    headers: signedHeaders('GET', PATH, new Uint8Array()),
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as { places: AdminListedPlace[] };
  const row = json.places.find((place) => place.externalId === externalId);
  if (row === undefined) {
    throw new Error(`missing admin place ${externalId}`);
  }
  return row;
}

function signedHeaders(
  method: string,
  pathWithQuery: string,
  body: Uint8Array,
  host = HOST,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    ...signAdminRequest({
      method,
      host,
      pathWithQuery,
      timestamp,
      body,
      privateKey: privateKey(),
      keyName: KEY_NAME,
    }),
  };
}

test('Function: adminRoutes — an unsigned /admin/places is 401', async ({ request }) => {
  const res = await request.get('/admin/places');
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: 'Unauthorized' });
});

test('Function: signAdminRequest — a signature for another host is 401', async ({ request }) => {
  const headers = signedHeaders('GET', PATH, new Uint8Array(), 'other.example');
  const res = await request.get('/admin/places', { headers });
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: 'Unauthorized' });
});

test('Function: canonicalString — a signed GET with a query string is accepted', async ({
  request,
}) => {
  const path = '/admin/places?x=1';
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = 'canonical-query-0001';
  const body = new Uint8Array();
  const canonical = canonicalString({
    method: 'GET',
    host: HOST,
    pathWithQuery: path,
    timestamp,
    nonce,
    body,
  });
  const headers = {
    'OCP-Admin-Key': KEY_NAME,
    'OCP-Admin-Timestamp': String(timestamp),
    'OCP-Admin-Nonce': nonce,
    'OCP-Admin-Signature': sign(null, Buffer.from(canonical, 'utf8'), privateKey()).toString(
      'base64',
    ),
  };
  const res = await request.get(path, { headers });
  expect(res.status()).toBe(200);
});

test('Function: decodeBase64 — a signature that is not base64 is 401', async ({ request }) => {
  const path = '/admin/places?n=bad-base64';
  const headers = signedHeaders('GET', path, new Uint8Array());
  headers['OCP-Admin-Signature'] = '***';
  const res = await request.get(path, { headers });
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: 'Unauthorized' });
});

test('Function: parseAdminPublicKeys — the e2e public key is accepted', async ({ request }) => {
  const path = '/admin/places?n=key';
  const res = await request.get(path, { headers: signedHeaders('GET', path, new Uint8Array()) });
  expect(res.status()).toBe(200);
});

test('Function: putPlace — PUT /admin/places creates a foreign origin', async ({ request }) => {
  const body = JSON.stringify(fremd);
  const headers = signedHeaders('PUT', PATH, Buffer.from(body));
  replay = { headers, body };
  const res = await request.put('/admin/places', { headers, data: body });
  expect(res.status()).toBe(201);
  expect(await res.json()).toMatchObject({ created: true });
});

test('Function: verifyAdminRequest — the same signed request is a replay', async ({ request }) => {
  if (replay === undefined) {
    throw new Error('missing signed put');
  }
  const res = await request.put('/admin/places', { headers: replay.headers, data: replay.body });
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: 'Unauthorized' });
});

test('Function: placeProblems — GET /admin/places shows complete and problems', async ({
  request,
}) => {
  const res = await request.get('/admin/places', {
    headers: signedHeaders('GET', PATH, new Uint8Array()),
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as {
    places: Array<{ origin: string; name: string; complete: boolean; problems: string[] }>;
  };
  const row = json.places.find((place) => place.origin === 'fremd' && place.name === fremd.name);
  expect(row?.complete).toBe(true);
  expect(row?.problems).toEqual([]);
});

test('Function: verifyAdminRequest — a fresh signature is accepted', async ({ request }) => {
  const path = '/admin/places?n=verify';
  const res = await request.get(path, { headers: signedHeaders('GET', path, new Uint8Array()) });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as { places: Array<{ complete: boolean; problems: string[] }> };
  expect(json.places.some((place) => place.complete === true && place.problems.length === 0)).toBe(
    true,
  );
});

test('Function: adminRoutes — GET /admin/places includes caller id and payment methods', async ({
  request,
}) => {
  const row = await listedPlace(request, fremd.externalId);
  expect(row.externalId).toBe(fremd.externalId);
  expect(row.paymentMethods).toBe('lightning');
  expect(row.name).toBe(fremd.name);
});

test('Function: adminRoutes — PUT /admin/places replaces a pin by its internal id', async ({
  request,
}) => {
  const row = await listedPlace(request, fremd.externalId);
  const body = JSON.stringify({
    ...fremd,
    id: row.id,
    name: 'Fremde Filiale Nord',
    paymentMethods: 'onchain',
  });
  const res = await request.put('/admin/places', {
    headers: signedHeaders('PUT', PATH, Buffer.from(body)),
    data: body,
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({
    created: false,
    id: row.id,
    npub: npubEncode(fremd.nostrPubkey),
    btcmap: 'skipped',
  });
  expect(row.npub).toBe(npubEncode(fremd.nostrPubkey));
  const updated = await listedPlace(request, fremd.externalId);
  expect(updated.id).toBe(row.id);
  expect(updated.name).toBe('Fremde Filiale Nord');
  expect(updated.paymentMethods).toBe('onchain');
});

test('Function: adminRoutes — PUT /admin/places with an unknown id inserts nothing', async ({
  request,
}) => {
  const body = JSON.stringify({
    ...fremd,
    id: 'missing-internal-id',
    name: 'Nope',
  });
  const res = await request.put('/admin/places', {
    headers: signedHeaders('PUT', PATH, Buffer.from(body)),
    data: body,
  });
  expect(res.status()).toBe(404);
  expect(await res.json()).toEqual({ error: 'Place not found' });
});

test('Function: adminRoutes — DELETE /admin/places with an unknown id deletes nothing', async ({
  request,
}) => {
  const body = JSON.stringify({ id: 'missing-internal-id', origin: 'NOT AN ORIGIN' });
  const res = await request.delete('/admin/places', {
    headers: signedHeaders('DELETE', PATH, Buffer.from(body)),
    data: body,
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ deleted: false });
  const row = await listedPlace(request, fremd.externalId);
  expect(row.origin).toBe(fremd.origin);
});

test('Function: adminRoutes — DELETE /admin/places removes one pin by its internal id', async ({
  request,
}) => {
  const created = {
    ...fremd,
    externalId: 'e2e-admin-by-id',
    name: 'By Id Shop',
    nostrPubkey: keyFor('e2e-admin-by-id'),
  };
  const createBody = JSON.stringify(created);
  const createdRes = await request.put('/admin/places', {
    headers: signedHeaders('PUT', PATH, Buffer.from(createBody)),
    data: createBody,
  });
  expect(createdRes.status()).toBe(201);
  const row = await listedPlace(request, created.externalId);
  const body = JSON.stringify({
    id: row.id,
    origin: created.origin,
    externalId: created.externalId,
  });
  const res = await request.delete('/admin/places', {
    headers: signedHeaders('DELETE', PATH, Buffer.from(body)),
    data: body,
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ deleted: true });
  const kept = await listedPlace(request, fremd.externalId);
  expect(kept.id).not.toBe(row.id);
});

test('Function: normalizeExternalId — a blank caller id on delete is rejected', async ({
  request,
}) => {
  const row = await listedPlace(request, fremd.externalId);
  const body = JSON.stringify({ id: row.id, externalId: '   ' });
  const res = await request.delete('/admin/places', {
    headers: signedHeaders('DELETE', PATH, Buffer.from(body)),
    data: body,
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ error: 'Place external id is required' });
  const kept = await listedPlace(request, fremd.externalId);
  expect(kept.id).toBe(row.id);
});

test('Function: adminRoutes — PUT /admin/places rewrites one internal id and rejects a taken pair', async ({
  request,
}) => {
  const fremdBefore = await listedPlace(request, fremd.externalId);
  expect(fremdBefore.origin).toBe(fremd.origin);
  expect(fremdBefore.externalId).toBe(fremd.externalId);

  const dedicated = {
    ...fremd,
    origin: 'dfx',
    externalId: 'e2e-admin-rewrite',
    name: 'Rewrite Shop',
    nostrPubkey: keyFor('e2e-admin-rewrite'),
  };
  const other = {
    ...fremd,
    origin: 'spar',
    externalId: 'e2e-admin-other',
    name: 'Other Shop',
    nostrPubkey: keyFor('e2e-admin-other'),
  };
  const createdAt = '2020-05-01T00:00:00.000Z';
  try {
    const createDedicated = JSON.stringify(dedicated);
    const createdDedicated = await request.put('/admin/places', {
      headers: signedHeaders('PUT', PATH, Buffer.from(createDedicated)),
      data: createDedicated,
    });
    expect(createdDedicated.status()).toBe(201);
    const createOther = JSON.stringify(other);
    const createdOther = await request.put('/admin/places', {
      headers: signedHeaders('PUT', PATH, Buffer.from(createOther)),
      data: createOther,
    });
    expect(createdOther.status()).toBe(201);

    const dedicatedRow = await listedPlace(request, dedicated.externalId);
    const otherRow = await listedPlace(request, other.externalId);
    const rewrite = JSON.stringify({
      ...dedicated,
      id: dedicatedRow.id,
      origin: 'gifts',
      externalId: 'e2e-admin-moved',
      createdAt,
      lastTransactionAt: null,
      activity: 'within30Days',
    });
    const rewritten = await request.put('/admin/places', {
      headers: signedHeaders('PUT', PATH, Buffer.from(rewrite)),
      data: rewrite,
    });
    expect(rewritten.status()).toBe(200);
    expect(await rewritten.json()).toEqual({
      created: false,
      id: dedicatedRow.id,
      npub: npubEncode(dedicated.nostrPubkey),
      btcmap: 'skipped',
    });
    const moved = await listedPlace(request, 'e2e-admin-moved');
    expect(moved.id).toBe(dedicatedRow.id);
    expect(moved.origin).toBe('gifts');
    expect(moved.externalId).toBe('e2e-admin-moved');
    expect(moved.createdAt).toBe(createdAt);
    expect(moved.lastTransactionAt).toBeNull();
    expect(moved.activity).toBe('within30Days');
    expect(moved.name).toBe(dedicated.name);

    const collide = JSON.stringify({
      ...dedicated,
      id: dedicatedRow.id,
      origin: other.origin,
      externalId: other.externalId,
      name: 'Should Not Collide',
      createdAt,
      lastTransactionAt: null,
      activity: 'within30Days',
    });
    const conflict = await request.put('/admin/places', {
      headers: signedHeaders('PUT', PATH, Buffer.from(collide)),
      data: collide,
    });
    expect(conflict.status()).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'Place already exists' });

    const stillMoved = await listedPlace(request, 'e2e-admin-moved');
    expect(stillMoved.id).toBe(dedicatedRow.id);
    expect(stillMoved.origin).toBe('gifts');
    expect(stillMoved.externalId).toBe('e2e-admin-moved');
    expect(stillMoved.name).toBe(dedicated.name);
    expect(stillMoved.createdAt).toBe(createdAt);
    expect(stillMoved.lastTransactionAt).toBeNull();
    expect(stillMoved.activity).toBe('within30Days');
    const stillOther = await listedPlace(request, other.externalId);
    expect(stillOther.id).toBe(otherRow.id);
    expect(stillOther.origin).toBe(other.origin);
    expect(stillOther.externalId).toBe(other.externalId);
    expect(stillOther.name).toBe(other.name);
    const fremdAfter = await listedPlace(request, fremd.externalId);
    expect(fremdAfter.id).toBe(fremdBefore.id);
    expect(fremdAfter.origin).toBe(fremd.origin);
    expect(fremdAfter.externalId).toBe(fremd.externalId);

    const deleteDedicated = JSON.stringify({ id: dedicatedRow.id });
    const deletedDedicated = await request.delete('/admin/places', {
      headers: signedHeaders('DELETE', PATH, Buffer.from(deleteDedicated)),
      data: deleteDedicated,
    });
    expect(deletedDedicated.status()).toBe(200);
    expect(await deletedDedicated.json()).toEqual({ deleted: true });
    const deleteOther = JSON.stringify({ id: otherRow.id });
    const deletedOther = await request.delete('/admin/places', {
      headers: signedHeaders('DELETE', PATH, Buffer.from(deleteOther)),
      data: deleteOther,
    });
    expect(deletedOther.status()).toBe(200);
    expect(await deletedOther.json()).toEqual({ deleted: true });
  } finally {
    for (const key of [
      { origin: 'gifts', externalId: 'e2e-admin-moved' },
      { origin: 'dfx', externalId: 'e2e-admin-rewrite' },
      { origin: 'spar', externalId: 'e2e-admin-other' },
    ]) {
      const body = JSON.stringify(key);
      await request.delete('/admin/places', {
        headers: signedHeaders('DELETE', PATH, Buffer.from(body)),
        data: body,
      });
    }
  }
});

test('Function: replacePlacePhotos — PUT /admin/places/photos stores a photo signed by an admin key', async ({
  request,
}) => {
  const key = keyFor('fremd/photo-admin');
  const place = { ...fremd, externalId: 'photo-admin', name: 'Admin Photo Shop', nostrPubkey: key };
  const placeBody = JSON.stringify(place);
  const created = await request.put('/admin/places', {
    headers: signedHeaders('PUT', PATH, Buffer.from(placeBody)),
    data: placeBody,
  });
  expect([200, 201]).toContain(created.status());
  const photoBody = JSON.stringify({
    origin: place.origin,
    nostrPubkey: key,
    photos: [{ contentType: 'image/png', data: base64(simplePng(9, 7)), caption: 'Front' }],
  });
  const stored = await request.put('/admin/places/photos', {
    headers: signedHeaders('PUT', '/admin/places/photos', Buffer.from(photoBody)),
    data: photoBody,
  });
  expect(stored.status()).toBe(200);
  const answer = (await stored.json()) as {
    photos: Array<{ url: string; width: number; height: number; caption: string }>;
    skipped: unknown[];
  };
  expect(answer.skipped).toEqual([]);
  expect(answer.photos).toHaveLength(1);
  expect(answer.photos[0]).toMatchObject({ width: 9, height: 7, caption: 'Front' });
  const unsigned = await request.put('/admin/places/photos', { data: photoBody });
  expect(unsigned.status()).toBe(401);
  const viaIngest = await request.put('/admin/places/photos', {
    headers: { Authorization: 'Bearer e2e-ingest' },
    data: photoBody,
  });
  expect(viaIngest.status()).toBe(401);
});

test('Function: deletePlace — DELETE /admin/places removes the pin', async ({ request }) => {
  const body = JSON.stringify({ origin: fremd.origin, externalId: fremd.externalId });
  const res = await request.delete('/admin/places', {
    headers: signedHeaders('DELETE', PATH, Buffer.from(body)),
    data: body,
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ deleted: true });
});

test('Function: ocp-admin CLI — keygen writes a private 0600 key and prints only the public line', () => {
  const home = mkdtempSync(join(tmpdir(), 'ocp-admin-home-'));
  try {
    const stdout = execFileSync('node', ['scripts/ocp-admin.mjs', 'keygen', 'laptop'], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      timeout: 15_000,
    });
    const publicLine = /^ed25519 ([A-Za-z0-9+/]{43}=) laptop\n$/u.exec(stdout);
    expect(stdout).toMatch(/^ed25519 [A-Za-z0-9+/]{43}= laptop\n$/u);
    expect(stdout).not.toContain('PRIVATE KEY');

    const dir = join(home, '.ocp-admin');
    const file = join(dir, 'laptop.key');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const before = readFileSync(file);
    const generatedPrivateKey = createPrivateKey({
      key: before,
      format: 'pem',
      type: 'pkcs8',
    });
    expect(generatedPrivateKey.asymmetricKeyType).toBe('ed25519');
    const publicDer = Buffer.from(
      createPublicKey(generatedPrivateKey).export({ format: 'der', type: 'spki' }),
    );
    expect(publicDer.subarray(12).toString('base64')).toBe(publicLine?.[1]);

    let secondKeygenError: unknown;
    try {
      execFileSync('node', ['scripts/ocp-admin.mjs', 'keygen', 'laptop'], {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
        timeout: 15_000,
      });
    } catch (error) {
      secondKeygenError = error;
    }
    expect(secondKeygenError).toBeDefined();
    expect(
      typeof secondKeygenError === 'object' &&
        secondKeygenError !== null &&
        'status' in secondKeygenError
        ? secondKeygenError.status
        : undefined,
    ).toBe(1);
    expect(
      typeof secondKeygenError === 'object' &&
        secondKeygenError !== null &&
        'stderr' in secondKeygenError &&
        typeof secondKeygenError.stderr === 'string'
        ? secondKeygenError.stderr
        : '',
    ).toContain('refusing to overwrite');
    expect(readFileSync(file).equals(before)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Function: ocp-admin CLI — a non-Ed25519 key file and a key name starting with - are rejected', () => {
  const home = mkdtempSync(join(tmpdir(), 'ocp-admin-home-'));
  try {
    const keyDir = join(home, '.ocp-admin');
    mkdirSync(keyDir, { mode: 0o700 });
    const { privateKey: ecPrivateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(join(keyDir, 'ec.key'), ecPrivateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    });

    let wrongTypeError: unknown;
    try {
      execFileSync(
        'node',
        ['scripts/ocp-admin.mjs', 'list', '--base', 'http://127.0.0.1:3000', '--key', 'ec'],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, HOME: home },
          encoding: 'utf8',
          timeout: 15_000,
        },
      );
    } catch (error) {
      wrongTypeError = error;
    }
    expect(wrongTypeError).toBeDefined();
    expect(
      typeof wrongTypeError === 'object' && wrongTypeError !== null && 'status' in wrongTypeError
        ? wrongTypeError.status
        : undefined,
    ).toBe(1);
    expect(
      typeof wrongTypeError === 'object' &&
        wrongTypeError !== null &&
        'stderr' in wrongTypeError &&
        typeof wrongTypeError.stderr === 'string'
        ? wrongTypeError.stderr
        : '',
    ).toContain('not a PKCS8 Ed25519 key');

    let invalidNameError: unknown;
    try {
      execFileSync('node', ['scripts/ocp-admin.mjs', 'keygen', '-bad'], {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
        timeout: 15_000,
      });
    } catch (error) {
      invalidNameError = error;
    }
    expect(invalidNameError).toBeDefined();
    expect(
      typeof invalidNameError === 'object' &&
        invalidNameError !== null &&
        'status' in invalidNameError
        ? invalidNameError.status
        : undefined,
    ).toBe(2);
    expect(
      typeof invalidNameError === 'object' &&
        invalidNameError !== null &&
        'stderr' in invalidNameError &&
        typeof invalidNameError.stderr === 'string'
        ? invalidNameError.stderr
        : '',
    ).toContain('Usage:');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Function: ocp-admin CLI — list, put, delete, and photos sign like the server', () => {
  const home = mkdtempSync(join(tmpdir(), 'ocp-admin-home-'));
  try {
    const privateKeyPem = process.env['OCP_E2E_ADMIN_PRIVATE_KEY'];
    if (privateKeyPem === undefined || privateKeyPem === '') {
      throw new Error('OCP_E2E_ADMIN_PRIVATE_KEY is missing');
    }

    const keyDir = join(home, '.ocp-admin');
    mkdirSync(keyDir, { mode: 0o700 });
    writeFileSync(join(keyDir, 'e2e.key'), privateKeyPem, { mode: 0o600 });

    const placesFile = join(home, 'places.json');
    writeFileSync(
      placesFile,
      JSON.stringify([
        { ...fremd, origin: 'cli', externalId: 'cli-1', nostrPubkey: keyFor('cli/cli-1') },
        {
          ...fremd,
          origin: 'cli',
          externalId: 'cli-2',
          name: 'CLI Two',
          nostrPubkey: keyFor('cli/cli-2'),
          revision: 1,
        },
      ]),
    );

    const run = (...args: string[]): string =>
      execFileSync(
        'node',
        ['scripts/ocp-admin.mjs', ...args, '--base', 'http://127.0.0.1:3000', '--key', 'e2e'],
        { cwd: REPO_ROOT, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 15_000 },
      );

    expect(run('put', placesFile)).toContain('ok cli-1');

    const photosFile = join(home, 'photos.json');
    writeFileSync(
      photosFile,
      JSON.stringify([
        {
          origin: 'cli',
          nostrPubkey: keyFor('cli/cli-1'),
          photos: [{ contentType: 'image/png', data: base64(simplePng(4, 3)) }],
        },
        { origin: 'cli', nostrPubkey: keyFor('cli/none'), photos: [] },
      ]),
    );
    let photosError: unknown;
    try {
      run('photos', photosFile);
    } catch (error) {
      photosError = error;
    }
    expect(
      typeof photosError === 'object' &&
        photosError !== null &&
        'stdout' in photosError &&
        typeof photosError.stdout === 'string'
        ? photosError.stdout
        : '',
    ).toBe(
      `ok ${keyFor('cli/cli-1')} 1 stored 0 skipped\nfail ${keyFor('cli/none')} 404 Place not found\n`,
    );

    let staleDeleteError: unknown;
    try {
      run('delete', 'cli', 'cli-2');
    } catch (error) {
      staleDeleteError = error;
    }
    expect(
      typeof staleDeleteError === 'object' &&
        staleDeleteError !== null &&
        'stdout' in staleDeleteError &&
        typeof staleDeleteError.stdout === 'string'
        ? staleDeleteError.stdout
        : '',
    ).toBe('fail cli-2 409 Stale revision\n');
    expect(run('delete', 'cli', 'cli-2', '--revision', '2')).toBe('ok cli-2\n');

    let badRevisionError: unknown;
    try {
      run('delete', 'cli', 'cli-2', '--revision', '0');
    } catch (error) {
      badRevisionError = error;
    }
    expect(
      typeof badRevisionError === 'object' &&
        badRevisionError !== null &&
        'status' in badRevisionError
        ? badRevisionError.status
        : undefined,
    ).toBe(2);
    expect(run('list')).toContain('"origin":"cli"');
    expect(run('delete', 'cli', 'cli-1')).toBe('ok cli-1\n');

    let secondDeleteError: unknown;
    try {
      run('delete', 'cli', 'cli-1');
    } catch (error) {
      secondDeleteError = error;
    }
    expect(secondDeleteError).toBeDefined();
    expect(
      typeof secondDeleteError === 'object' &&
        secondDeleteError !== null &&
        'stdout' in secondDeleteError &&
        typeof secondDeleteError.stdout === 'string'
        ? secondDeleteError.stdout
        : '',
    ).toContain('missing cli-1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Function: adminRoutes — a body above 64 KiB with Content-Length is 413', async ({
  request,
}) => {
  const response = await request.put('/admin/places', {
    data: Buffer.alloc(64 * 1024 + 1, 0x61),
    headers: { 'Content-Type': 'application/json' },
  });

  expect(response.status()).toBe(413);
  await expect(response.json()).resolves.toEqual({ error: 'Payload too large' });
});

test('Function: SqliteMapPlaceStore — a deactivated shop leaves the public list', async ({
  request,
}) => {
  const key = keyFor('e2e-active-shop');
  const npub = npubEncode(key);
  const place = {
    origin: 'fremd',
    externalId: 'e2e-active-shop',
    name: 'Hidden Filiale',
    description: DESCRIPTION,
    lat: 47.37,
    lon: 8.54,
    category: 'groceries',
    paymentMethods: 'lightning',
    shopType: 'SPAR',
    street: 'Maschlinastrasse',
    houseNumber: '4',
    postalCode: '9495',
    city: 'Triesen',
    country: 'LI',
    nostrPubkey: key,
  };
  const ingest = { Authorization: 'Bearer e2e-ingest' };
  const created = await request.post('/map/places', { headers: ingest, data: place });
  expect(created.status()).toBe(201);
  const stored = await request.put('/map/places/photos', {
    headers: ingest,
    data: {
      origin: place.origin,
      nostrPubkey: key,
      photos: [{ contentType: 'image/png', data: base64(simplePng(13, 6)) }],
    },
  });
  expect(stored.status()).toBe(200);
  const uploaded = (await stored.json()) as { photos: Array<{ url: string }> };
  const photoUrl = uploaded.photos[0]?.url;
  if (photoUrl === undefined) {
    throw new Error('missing photo');
  }
  const photoPath = new URL(photoUrl).pathname;
  const served = await request.get(photoPath);
  expect(served.status()).toBe(200);
  const row = await listedPlace(request, place.externalId);
  expect(row.active).toBe(true);
  expect(row.complete).toBe(true);
  const hideBody = JSON.stringify({ ...place, id: row.id, active: false });
  const hidden = await request.put('/admin/places', {
    headers: signedHeaders('PUT', PATH, Buffer.from(hideBody)),
    data: hideBody,
  });
  expect(hidden.status()).toBe(200);
  expect(await hidden.json()).toEqual({
    created: false,
    id: row.id,
    npub,
    btcmap: 'skipped',
  });
  const omitted = (await (await request.get('/map/places')).json()) as {
    places: Array<{ id: string }>;
  };
  expect(omitted.places.some((item) => item.id === npub)).toBe(false);
  const detail = await request.get(`/map/places/${npub}`);
  expect(detail.status()).toBe(404);
  expect(await detail.json()).toEqual({ error: 'Place not found' });
  const hex = await request.get(`/map/places/${key}`, { maxRedirects: 0 });
  expect(hex.status()).toBe(404);
  expect(await hex.json()).toEqual({ error: 'Place not found' });
  const hiddenRow = await listedPlace(request, place.externalId);
  expect(hiddenRow).toMatchObject({ id: row.id, active: false, complete: true });
  const photoGone = await request.get(photoPath);
  expect(photoGone.status()).toBe(404);
  expect(await photoGone.json()).toEqual({ error: 'Photo not found' });
  const source = await request.put('/map/places', {
    headers: ingest,
    data: { ...place, name: 'Still Hidden Filiale' },
  });
  expect(source.status()).toBe(200);
  const stillHidden = (await (await request.get('/map/places')).json()) as {
    places: Array<{ id: string }>;
  };
  expect(stillHidden.places.some((item) => item.id === npub)).toBe(false);
  expect(await listedPlace(request, place.externalId)).toMatchObject({
    active: false,
    name: 'Still Hidden Filiale',
  });
  const showBody = JSON.stringify({ ...place, id: row.id, active: true });
  const shown = await request.put('/admin/places', {
    headers: signedHeaders('PUT', PATH, Buffer.from(showBody)),
    data: showBody,
  });
  expect(shown.status()).toBe(200);
  const listed = (await (await request.get('/map/places')).json()) as {
    places: Array<{ id: string }>;
  };
  expect(listed.places.some((item) => item.id === npub)).toBe(true);
  const detailAgain = await request.get(`/map/places/${npub}`);
  expect(detailAgain.status()).toBe(200);
  const photoAgain = await request.get(photoPath);
  expect(photoAgain.status()).toBe(200);
  expect(photoAgain.headers()['content-type']).toContain('image/png');
  expect((await listedPlace(request, place.externalId)).active).toBe(true);
});
