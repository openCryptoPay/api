import { createHash, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { decodeBase64, type AdminPublicKey } from '@/lib/admin/keys';

/** Requests older or newer than this many seconds are rejected. */
const ADMIN_WINDOW_SECONDS = 60;

/** 16 to 64 characters from the URL-safe alphabet. */
const ADMIN_NONCE = /^[A-Za-z0-9_-]{16,64}$/u;

/**
 * Headers a device sends on every admin request. Names are exact; HTTP treats
 * them as case-insensitive on the wire.
 */
export type AdminSignatureHeaders = {
  'OCP-Admin-Key': string;
  'OCP-Admin-Timestamp': string;
  'OCP-Admin-Signature': string;
  'OCP-Admin-Nonce': string;
};

/**
 * Seen nonces for one process. The key is `${keyName}\n${nonce}`.
 * The value is the unix-second expiry (`timestamp + 60`).
 * The caller keeps one map for the life of the server.
 */
export type AdminReplayCache = Map<string, number>;

/**
 * UTF-8 canonical string covered by the Ed25519 signature.
 *
 * `OCP-ADMIN-v1`, the method in upper case, the host, the path plus the query
 * string exactly as sent, the timestamp, the nonce, and the hex SHA-256 of the
 * raw body. An empty body hashes as zero bytes. Fields are joined with `\n`
 * and there is no trailing newline.
 *
 * @param input - Method, configured host, exact path and query, unix seconds, nonce, and raw body.
 * @returns The string the device signs and the server rebuilds.
 * @throws When `timestamp` is not a safe integer, or the nonce does not match the format.
 */
export function canonicalString(input: {
  method: string;
  host: string;
  pathWithQuery: string;
  timestamp: number;
  nonce: string;
  body: Uint8Array;
}): string {
  if (!Number.isSafeInteger(input.timestamp)) {
    throw new Error('Admin timestamp must be an integer');
  }
  if (!ADMIN_NONCE.test(input.nonce)) {
    throw new Error('Admin nonce is invalid');
  }
  const hash = sha256Hex(input.body);
  return [
    'OCP-ADMIN-v1',
    input.method.toUpperCase(),
    input.host,
    input.pathWithQuery,
    String(input.timestamp),
    input.nonce,
    hash,
  ].join('\n');
}

/**
 * Sign one admin request. The host is the name the server was configured with,
 * not a header the client picked. `keyName` is sent as `OCP-Admin-Key` and is
 * not part of the signed string. `nonce` is part of the signed string and is
 * sent as `OCP-Admin-Nonce`. When `nonce` is omitted, 16 random bytes are
 * encoded as base64url.
 *
 * @param input - Method, host, path and query, unix seconds, raw body, PKCS8 Ed25519 key,
 * key name, and optional nonce.
 * @returns `OCP-Admin-Key`, `OCP-Admin-Timestamp`, `OCP-Admin-Signature`, and `OCP-Admin-Nonce`.
 * @throws When `timestamp` is not a safe integer, or `nonce` is present and invalid.
 */
export function signAdminRequest(input: {
  method: string;
  host: string;
  pathWithQuery: string;
  timestamp: number;
  body: Uint8Array;
  privateKey: KeyObject;
  keyName: string;
  nonce?: string;
}): AdminSignatureHeaders {
  const nonce = input.nonce ?? randomBytes(16).toString('base64url');
  const payload = Buffer.from(
    canonicalString({
      method: input.method,
      host: input.host,
      pathWithQuery: input.pathWithQuery,
      timestamp: input.timestamp,
      nonce,
      body: input.body,
    }),
    'utf8',
  );
  return {
    'OCP-Admin-Key': input.keyName,
    'OCP-Admin-Timestamp': String(input.timestamp),
    'OCP-Admin-Signature': sign(null, payload, input.privateKey).toString('base64'),
    'OCP-Admin-Nonce': nonce,
  };
}

/**
 * Check one admin request against the allowed keys.
 *
 * A missing or malformed nonce returns false before any signature work and
 * records nothing. The key name must be known. The timestamp header must be an
 * integer whose distance from `nowSeconds` is at most 60 seconds. The signature
 * must verify with `verify(null, data, publicKey, sig)` over {@link canonicalString},
 * using `host` from the server config. A nonce already stored for that key in
 * `replay` is rejected. On success `${keyName}\n${nonce}` is stored until
 * `timestamp + 60`.
 *
 * Expired map entries are removed at the start of every call. Every failure
 * returns false and does not record the nonce.
 *
 * @param input - Allowed keys, headers, request bytes, clock, and the process replay map.
 * @returns True only when the request is fresh, signed, and not a replay.
 */
export function verifyAdminRequest(input: {
  keys: readonly AdminPublicKey[];
  keyName: string | undefined;
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
  method: string;
  host: string;
  pathWithQuery: string;
  body: Uint8Array;
  nowSeconds: number;
  replay: AdminReplayCache;
}): boolean {
  pruneReplay(input.replay, input.nowSeconds);
  const nonce = input.nonce;
  if (!isAdminNonce(nonce)) {
    return false;
  }
  if (!Number.isSafeInteger(input.nowSeconds)) {
    return false;
  }
  const key = findKey(input.keys, input.keyName);
  if (key === undefined) {
    return false;
  }
  const timestamp = parseTimestamp(input.timestamp);
  if (timestamp === undefined) {
    return false;
  }
  if (Math.abs(input.nowSeconds - timestamp) > ADMIN_WINDOW_SECONDS) {
    return false;
  }
  const signature = decodeSignature(input.signature);
  if (signature === undefined) {
    return false;
  }
  const payload = Buffer.from(
    canonicalString({
      method: input.method,
      host: input.host,
      pathWithQuery: input.pathWithQuery,
      timestamp,
      nonce,
      body: input.body,
    }),
    'utf8',
  );
  if (!verify(null, payload, key.publicKey, signature)) {
    return false;
  }
  const replayKey = `${key.name}\n${nonce}`;
  if (input.replay.has(replayKey)) {
    return false;
  }
  input.replay.set(replayKey, timestamp + ADMIN_WINDOW_SECONDS);
  return true;
}

/** Lower-case hex SHA-256 of the raw body. Empty input is the hash of zero bytes. */
function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function findKey(
  keys: readonly AdminPublicKey[],
  name: string | undefined,
): AdminPublicKey | undefined {
  if (name === undefined) {
    return undefined;
  }
  for (const key of keys) {
    if (key.name === name) {
      return key;
    }
  }
  return undefined;
}

function parseTimestamp(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^-?\d+$/u.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return undefined;
  }
  return value;
}

function decodeSignature(raw: string | undefined): Buffer | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const decoded = decodeBase64(raw);
  if (decoded === undefined || decoded.length !== 64) {
    return undefined;
  }
  return decoded;
}

function isAdminNonce(nonce: string | undefined): nonce is string {
  return nonce !== undefined && ADMIN_NONCE.test(nonce);
}

function pruneReplay(replay: AdminReplayCache, nowSeconds: number): void {
  for (const [replayKey, expiry] of replay) {
    if (expiry < nowSeconds) {
      replay.delete(replayKey);
    }
  }
}
