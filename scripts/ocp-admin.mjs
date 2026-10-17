#!/usr/bin/env node
/**
 * Device CLI for /admin. The Ed25519 private key stays in ~/.ocp-admin/<name>.key
 * and is never printed. The signed string matches src/lib/admin/signature.ts.
 */
import { Buffer } from 'node:buffer';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY_NAME = /^[A-Za-z0-9._@][A-Za-z0-9._@-]{0,63}$/u;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ADMIN_PATH = '/admin/places';

function usage() {
  process.stderr.write(`Usage:
  ocp-admin.mjs keygen <name>
  ocp-admin.mjs list --base <https://host> --key <name>
  ocp-admin.mjs put <file.json> --base <https://host> --key <name>
  ocp-admin.mjs delete <origin> <externalId> --base <https://host> --key <name>

<name> matches ^[A-Za-z0-9._@][A-Za-z0-9._@-]{0,63}$. The key file is ~/.ocp-admin/<name>.key.
Exit 2 when the arguments are wrong.
`);
}

function failUsage() {
  usage();
  process.exit(2);
}

function parseArgs(argv) {
  const positional = [];
  let base;
  let key;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base' || arg === '--key') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        failUsage();
      }
      if (arg === '--base') {
        if (base !== undefined) {
          failUsage();
        }
        base = value;
      } else if (key !== undefined) {
        failUsage();
      } else {
        key = value;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      failUsage();
    }
    positional.push(arg);
  }
  return { positional, base, key };
}

function keyPath(name) {
  return join(homedir(), '.ocp-admin', `${name}.key`);
}

function loadPrivateKey(name) {
  let pem;
  try {
    pem = readFileSync(keyPath(name));
  } catch {
    process.stderr.write('admin key file is missing\n');
    process.exit(1);
  }
  let key;
  try {
    key = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
  } catch {
    process.stderr.write('admin key file is not a PKCS8 Ed25519 key\n');
    process.exit(1);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    process.stderr.write('admin key file is not a PKCS8 Ed25519 key\n');
    process.exit(1);
  }
  return key;
}

function endpoint(base, key) {
  if (base === undefined || key === undefined || !KEY_NAME.test(key)) {
    failUsage();
  }
  let url;
  try {
    url = new globalThis.URL(base);
  } catch {
    failUsage();
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname === ''
  ) {
    failUsage();
  }
  return { hostname: url.hostname, origin: url.origin, key };
}

function requestUrl(origin, pathWithQuery) {
  const target = new globalThis.URL(pathWithQuery, `${origin}/`);
  if (`${target.pathname}${target.search}` !== pathWithQuery) {
    process.stderr.write('admin path does not match the request URL\n');
    process.exit(1);
  }
  return target;
}

function adminHeaders(method, host, pathWithQuery, body, privateKey, keyName) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString('base64url');
  const canonical = [
    'OCP-ADMIN-v1',
    method.toUpperCase(),
    host,
    pathWithQuery,
    String(timestamp),
    nonce,
    createHash('sha256').update(body).digest('hex'),
  ].join('\n');
  return {
    'OCP-Admin-Key': keyName,
    'OCP-Admin-Timestamp': String(timestamp),
    'OCP-Admin-Nonce': nonce,
    'OCP-Admin-Signature': sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString(
      'base64',
    ),
  };
}

async function signedFetch(method, where, pathWithQuery, body, privateKey) {
  const headers = adminHeaders(method, where.hostname, pathWithQuery, body, privateKey, where.key);
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers['content-type'] = 'application/json';
    init.body = body;
  }
  return globalThis.fetch(requestUrl(where.origin, pathWithQuery), init);
}

function oneLine(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

async function apiError(response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof parsed.error === 'string'
    ) {
      const message = oneLine(parsed.error);
      return message === '' ? 'error' : message;
    }
  } catch {
    // The body is not JSON. The collapsed text is the error.
  }
  const message = oneLine(text);
  return message === '' ? 'error' : message;
}

function externalIdOf(value) {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.externalId === 'string' &&
    value.externalId !== ''
  ) {
    return value.externalId.replace(/[\r\n]+/gu, ' ');
  }
  return '-';
}

function publicLine(publicKey, name) {
  const der = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
  const prefix = der.subarray(0, ED25519_SPKI_PREFIX.length);
  if (der.length !== ED25519_SPKI_PREFIX.length + 32 || !prefix.equals(ED25519_SPKI_PREFIX)) {
    process.stderr.write('could not read the new public key\n');
    process.exit(1);
  }
  return `ed25519 ${der.subarray(ED25519_SPKI_PREFIX.length).toString('base64')} ${name}`;
}

function cmdKeygen(argv) {
  if (argv.length !== 1 || !KEY_NAME.test(argv[0])) {
    failUsage();
  }
  const name = argv[0];
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const line = publicLine(publicKey, name);
  const exported = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const pem = typeof exported === 'string' ? exported : Buffer.from(exported).toString('utf8');
  const dir = join(homedir(), '.ocp-admin');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  try {
    writeFileSync(keyPath(name), pem, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (typeof error === 'object' && error !== null && error.code === 'EEXIST') {
      process.stderr.write('refusing to overwrite the admin key file\n');
      process.exit(1);
    }
    process.stderr.write('could not write the admin key file\n');
    process.exit(1);
  }
  chmodSync(keyPath(name), 0o600);
  process.stdout.write(`${line}\n`);
}

async function cmdList(argv) {
  const args = parseArgs(argv);
  if (args.positional.length !== 0) {
    failUsage();
  }
  const where = endpoint(args.base, args.key);
  const response = await signedFetch(
    'GET',
    where,
    ADMIN_PATH,
    Buffer.alloc(0),
    loadPrivateKey(where.key),
  );
  if (!response.ok) {
    const message = await apiError(response);
    process.stderr.write(`fail ${String(response.status)} ${message}\n`);
    process.exit(1);
  }
  const text = await response.text();
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

async function cmdPut(argv) {
  const args = parseArgs(argv);
  if (args.positional.length !== 1) {
    failUsage();
  }
  const where = endpoint(args.base, args.key);
  const file = args.positional[0];
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    process.stderr.write('could not read the put file\n');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    process.stderr.write('put file is not JSON\n');
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    process.stderr.write('put file must be a JSON array\n');
    process.exit(1);
  }
  const privateKey = loadPrivateKey(where.key);
  let failed = false;
  for (const element of parsed) {
    const externalId = externalIdOf(element);
    if (typeof element !== 'object' || element === null || Array.isArray(element)) {
      process.stdout.write(`fail ${externalId} 0 invalid place\n`);
      failed = true;
      continue;
    }
    const body = Buffer.from(JSON.stringify(element), 'utf8');
    let response;
    try {
      response = await signedFetch('PUT', where, ADMIN_PATH, body, privateKey);
    } catch {
      process.stdout.write(`fail ${externalId} 0 request failed\n`);
      failed = true;
      continue;
    }
    if (response.ok) {
      process.stdout.write(`ok ${externalId}\n`);
      continue;
    }
    const message = await apiError(response);
    process.stdout.write(`fail ${externalId} ${String(response.status)} ${message}\n`);
    failed = true;
  }
  if (failed) {
    process.exit(1);
  }
}

async function cmdDelete(argv) {
  const args = parseArgs(argv);
  if (args.positional.length !== 2 || args.positional[0] === '' || args.positional[1] === '') {
    failUsage();
  }
  const origin = args.positional[0];
  const externalId = args.positional[1];
  const where = endpoint(args.base, args.key);
  const body = Buffer.from(JSON.stringify({ origin, externalId }), 'utf8');
  let response;
  try {
    response = await signedFetch('DELETE', where, ADMIN_PATH, body, loadPrivateKey(where.key));
  } catch {
    process.stdout.write(`fail ${externalId} 0 request failed\n`);
    process.exit(1);
  }
  if (!response.ok) {
    const message = await apiError(response);
    process.stdout.write(`fail ${externalId} ${String(response.status)} ${message}\n`);
    process.exit(1);
  }
  let result;
  try {
    result = await response.json();
  } catch {
    process.stdout.write(`fail ${externalId} ${String(response.status)} unexpected response\n`);
    process.exit(1);
  }
  if (typeof result !== 'object' || result === null || typeof result.deleted !== 'boolean') {
    process.stdout.write(`fail ${externalId} ${String(response.status)} unexpected response\n`);
    process.exit(1);
  }
  if (result.deleted) {
    process.stdout.write(`ok ${externalId}\n`);
    return;
  }
  process.stdout.write(`missing ${externalId}\n`);
  process.exit(1);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'keygen') {
    cmdKeygen(rest);
    return;
  }
  if (command === 'list') {
    await cmdList(rest);
    return;
  }
  if (command === 'put') {
    await cmdPut(rest);
    return;
  }
  if (command === 'delete') {
    await cmdDelete(rest);
    return;
  }
  failUsage();
}

try {
  await main();
} catch {
  process.stderr.write('request failed\n');
  process.exit(1);
}
