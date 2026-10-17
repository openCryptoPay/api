import { createPublicKey, type KeyObject } from 'node:crypto';

/** SPKI prefix for a raw 32-byte Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const KEY_NAME = /^[A-Za-z0-9._@-]{1,64}$/u;

/**
 * One device allowed to call `/admin`. `publicKey` is its Ed25519 public key.
 * The private key never arrives here.
 */
export type AdminPublicKey = {
  name: string;
  publicKey: KeyObject;
};

/**
 * Parse `OCP_ADMIN_PUBLIC_KEYS`.
 *
 * The value is newline-separated. Blank lines and lines whose first
 * non-whitespace character is `#` are ignored. Every other line is
 * `ed25519 <base64 of the raw 32-byte key> <name>` or
 * `ssh-ed25519 <base64 of the OpenSSH wire blob> <name>`. The wire blob is a
 * uint32 length, the text `ssh-ed25519`, a uint32 length, and the 32-byte key,
 * and nothing after that. `<name>` matches `^[A-Za-z0-9._@-]{1,64}$` and is
 * unique. Base64 may be padded or unpadded.
 *
 * A bad line, a repeated name, or repeated key material throws before a key
 * list is returned.
 *
 * @param raw - Environment value, split on `\n` or `\r\n`. Line numbers count every line.
 * @returns Allowed keys in file order. Empty when every line is blank or a comment.
 * @throws The message names the 1-based line. `malformed key`, `duplicate key name`, or
 * `duplicate key`.
 */
export function parseAdminPublicKeys(raw: string): AdminPublicKey[] {
  const keys: AdminPublicKey[] = [];
  const names = new Set<string>();
  const material = new Set<string>();
  let lineNumber = 0;
  for (const line of raw.split(/\r?\n/u)) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const parsed = parseKeyLine(trimmed, lineNumber);
    if (names.has(parsed.name)) {
      throw new Error(`OCP_ADMIN_PUBLIC_KEYS line ${String(lineNumber)}: duplicate key name`);
    }
    const keyMaterial = Buffer.from(
      parsed.publicKey.export({ format: 'der', type: 'spki' }),
    ).toString('hex');
    if (material.has(keyMaterial)) {
      throw new Error(`OCP_ADMIN_PUBLIC_KEYS line ${String(lineNumber)}: duplicate key`);
    }
    names.add(parsed.name);
    material.add(keyMaterial);
    keys.push(parsed);
  }
  return keys;
}

function malformed(lineNumber: number): Error {
  return new Error(`OCP_ADMIN_PUBLIC_KEYS line ${String(lineNumber)}: malformed key`);
}

function parseKeyLine(line: string, lineNumber: number): AdminPublicKey {
  const parts = line.split(/\s+/u);
  if (parts.length !== 3) {
    throw malformed(lineNumber);
  }
  const format = parts[0];
  const encoded = parts[1];
  const name = parts[2];
  // `split` on a length of 3 is a dense triple. The checks exist for the type.
  /* v8 ignore next 3 -- @preserve split length 3 is three defined tokens */
  if (format === undefined || encoded === undefined || name === undefined) {
    throw malformed(lineNumber);
  }
  if (!KEY_NAME.test(name)) {
    throw malformed(lineNumber);
  }
  const raw = decodePublicKey(format, encoded, lineNumber);
  return {
    name,
    publicKey: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    }),
  };
}

function decodePublicKey(format: string, encoded: string, lineNumber: number): Buffer {
  const decoded = decodeBase64(encoded);
  if (decoded === undefined) {
    throw malformed(lineNumber);
  }
  if (format === 'ed25519') {
    if (decoded.length !== 32) {
      throw malformed(lineNumber);
    }
    return decoded;
  }
  if (format === 'ssh-ed25519') {
    const raw = parseSshEd25519(decoded);
    if (raw === undefined) {
      throw malformed(lineNumber);
    }
    return raw;
  }
  throw malformed(lineNumber);
}

/**
 * Strict standard base64, padded or unpadded. Rejects a bad alphabet, a length
 * of 4n+1, and padding that does not match the body.
 *
 * @param value - One token.
 * @returns Decoded bytes, or undefined when the token is not base64.
 */
export function decodeBase64(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return undefined;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const body = value.slice(0, value.length - padding);
  if (body.length % 4 === 1) {
    return undefined;
  }
  const expectedPad = (4 - (body.length % 4)) % 4;
  if (padding !== 0 && padding !== expectedPad) {
    return undefined;
  }
  return Buffer.from(body + '='.repeat(expectedPad), 'base64');
}

function readSshString(buf: Buffer, offset: number): { value: Buffer; next: number } | undefined {
  if (offset + 4 > buf.length) {
    return undefined;
  }
  const length = buf.readUInt32BE(offset);
  const start = offset + 4;
  if (length > buf.length - start) {
    return undefined;
  }
  return { value: buf.subarray(start, start + length), next: start + length };
}

/** OpenSSH wire blob: type string `ssh-ed25519`, then the 32-byte key, then end. */
function parseSshEd25519(blob: Buffer): Buffer | undefined {
  const type = readSshString(blob, 0);
  if (type === undefined) {
    return undefined;
  }
  if (type.value.toString('utf8') !== 'ssh-ed25519') {
    return undefined;
  }
  const key = readSshString(blob, type.next);
  if (key === undefined) {
    return undefined;
  }
  if (key.value.length !== 32) {
    return undefined;
  }
  if (key.next !== blob.length) {
    return undefined;
  }
  return Buffer.from(key.value);
}
