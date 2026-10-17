import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdminPublicKey } from '@/lib/admin/keys';
import {
  canonicalString,
  signAdminRequest,
  verifyAdminRequest,
  type AdminReplayCache,
  type AdminSignatureHeaders,
} from '@/lib/admin/signature';

const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TS = 1_700_000_000;
const HOST = 'admin.example';
const PATH = '/admin/places';
const NONCE = 'nonce-0123456789abcd';
const EMPTY = new Uint8Array();

const pair = generateKeyPairSync('ed25519');
const desk: AdminPublicKey = { name: 'desk', publicKey: pair.publicKey };

const phonePair = generateKeyPairSync('ed25519');
const phone: AdminPublicKey = { name: 'phone', publicKey: phonePair.publicKey };

function sign(over?: {
  method?: string;
  host?: string;
  pathWithQuery?: string;
  body?: Uint8Array;
  nonce?: string;
}): AdminSignatureHeaders {
  return signAdminRequest({
    method: over?.method ?? 'GET',
    host: over?.host ?? HOST,
    pathWithQuery: over?.pathWithQuery ?? PATH,
    timestamp: TS,
    nonce: over?.nonce ?? NONCE,
    body: over?.body ?? EMPTY,
    privateKey: pair.privateKey,
    keyName: 'desk',
  });
}

function check(
  headers: AdminSignatureHeaders,
  over: {
    method?: string;
    host?: string;
    pathWithQuery?: string;
    body?: Uint8Array;
    nowSeconds?: number;
    keyName?: string | undefined;
    signature?: string | undefined;
    timestamp?: string | undefined;
    nonce?: string | undefined;
    replay?: AdminReplayCache;
    keys?: readonly AdminPublicKey[];
  } = {},
): boolean {
  return verifyAdminRequest({
    keys: over.keys ?? [desk],
    keyName: 'keyName' in over ? over.keyName : headers['OCP-Admin-Key'],
    timestamp: 'timestamp' in over ? over.timestamp : headers['OCP-Admin-Timestamp'],
    nonce: 'nonce' in over ? over.nonce : headers['OCP-Admin-Nonce'],
    signature: 'signature' in over ? over.signature : headers['OCP-Admin-Signature'],
    method: over.method ?? 'GET',
    host: over.host ?? HOST,
    pathWithQuery: over.pathWithQuery ?? PATH,
    body: over.body ?? EMPTY,
    nowSeconds: over.nowSeconds ?? TS,
    replay: over.replay ?? new Map(),
  });
}

describe('admin signature', () => {
  it('builds the canonical string for an empty body', () => {
    const text = canonicalString({
      method: 'get',
      host: HOST,
      pathWithQuery: PATH,
      timestamp: TS,
      nonce: NONCE,
      body: EMPTY,
    });
    expect(text).toBe(['OCP-ADMIN-v1', 'GET', HOST, PATH, String(TS), NONCE, EMPTY_SHA].join('\n'));
  });

  it('rejects a non-integer canonical timestamp', () => {
    expect(() =>
      canonicalString({
        method: 'GET',
        host: HOST,
        pathWithQuery: PATH,
        timestamp: 1.5,
        nonce: NONCE,
        body: EMPTY,
      }),
    ).toThrow(/integer/);
  });

  it('rejects a malformed canonical nonce', () => {
    expect(() =>
      canonicalString({
        method: 'GET',
        host: HOST,
        pathWithQuery: PATH,
        timestamp: TS,
        nonce: 'short',
        body: EMPTY,
      }),
    ).toThrow('Admin nonce is invalid');
  });

  it('returns the four admin headers', () => {
    const input = {
      method: 'GET',
      host: HOST,
      pathWithQuery: PATH,
      timestamp: TS,
      body: EMPTY,
      privateKey: pair.privateKey,
      keyName: 'desk',
    };
    const headers = signAdminRequest(input);
    const again = signAdminRequest(input);
    expect(headers['OCP-Admin-Key']).toBe('desk');
    expect(headers['OCP-Admin-Timestamp']).toBe(String(TS));
    expect(headers['OCP-Admin-Signature']).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    expect(headers['OCP-Admin-Nonce']).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(again['OCP-Admin-Nonce']).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(again['OCP-Admin-Nonce']).not.toBe(headers['OCP-Admin-Nonce']);
  });

  it('echoes an explicit nonce', () => {
    const headers = sign({ nonce: 'explicit-nonce-01' });
    expect(headers['OCP-Admin-Nonce']).toBe('explicit-nonce-01');
    expect(check(headers)).toBe(true);
  });

  it('signs and verifies', () => {
    const headers = sign();
    expect(check(headers)).toBe(true);
    const bare = headers['OCP-Admin-Signature'].replace(/=+$/u, '');
    expect(check({ ...headers, 'OCP-Admin-Signature': bare })).toBe(true);
  });

  it('rejects a different host', () => {
    expect(check(sign(), { host: 'other.example' })).toBe(false);
  });

  it('rejects a different method', () => {
    expect(check(sign(), { method: 'POST' })).toBe(false);
  });

  it('rejects a different path', () => {
    expect(check(sign(), { pathWithQuery: '/admin/other' })).toBe(false);
  });

  it('rejects a different query', () => {
    expect(check(sign(), { pathWithQuery: `${PATH}?x=1` })).toBe(false);
  });

  it('rejects a different body', () => {
    expect(check(sign(), { body: new Uint8Array([1]) })).toBe(false);
  });

  it('rejects an unknown key', () => {
    expect(check(sign(), { keyName: 'other' })).toBe(false);
  });

  it('rejects a missing key name', () => {
    expect(check(sign(), { keyName: undefined })).toBe(false);
  });

  it('accepts a timestamp 60 seconds away', () => {
    const headers = sign();
    expect(check(headers, { nowSeconds: TS + 60 })).toBe(true);
    expect(check(headers, { nowSeconds: TS - 60 })).toBe(true);
  });

  it('rejects a timestamp 61 seconds away', () => {
    const headers = sign();
    expect(check(headers, { nowSeconds: TS + 61 })).toBe(false);
    expect(check(headers, { nowSeconds: TS - 61 })).toBe(false);
  });

  it('rejects a non-integer timestamp', () => {
    const headers = sign();
    expect(check(headers, { timestamp: '1.5' })).toBe(false);
    expect(check(headers, { timestamp: 'abc' })).toBe(false);
    expect(check(headers, { timestamp: undefined })).toBe(false);
  });

  it('rejects a replay', () => {
    const headers = sign();
    const replay: AdminReplayCache = new Map();
    expect(check(headers, { replay })).toBe(true);
    expect(check(headers, { replay })).toBe(false);
  });

  it('removes an expired replay entry once now is past expiry', () => {
    const replay: AdminReplayCache = new Map([
      ['gone', TS],
      ['stay', TS + 5],
    ]);
    expect(check(sign(), { nowSeconds: TS + 1, replay })).toBe(true);
    expect(replay.has('gone')).toBe(false);
    expect(replay.has('stay')).toBe(true);
  });

  it('rejects a broken signature encoding', () => {
    const headers = sign();
    expect(check(headers, { signature: 'ab$c' })).toBe(false);
    expect(check(headers, { signature: 'abcde' })).toBe(false);
    expect(check(headers, { signature: 'AAAA=' })).toBe(false);
  });

  it('rejects a signature of the wrong length', () => {
    const signature = Buffer.alloc(32).toString('base64');
    expect(check(sign(), { signature })).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(check(sign(), { signature: undefined })).toBe(false);
  });

  it('rejects a non-integer now', () => {
    expect(check(sign(), { nowSeconds: 1.5 })).toBe(false);
  });

  it('rejects a timestamp outside the safe integer range', () => {
    expect(check(sign(), { timestamp: '9007199254740993' })).toBe(false);
  });

  it('accepts two nonces for the same request', () => {
    const replay: AdminReplayCache = new Map();
    const first = sign({ nonce: 'nonce-a-0123456789' });
    const second = sign({ nonce: 'nonce-b-0123456789' });
    expect(check(first, { replay })).toBe(true);
    expect(check(second, { replay })).toBe(true);
  });

  it('rejects the same nonce a second time', () => {
    const headers = sign({ nonce: 'nonce-once-0123456' });
    const replay: AdminReplayCache = new Map();
    expect(check(headers, { replay })).toBe(true);
    expect(check(headers, { replay })).toBe(false);
  });

  it('accepts the same nonce for a different key', () => {
    const nonce = 'shared-nonce-0001';
    const deskHeaders = sign({ nonce });
    const phoneHeaders = signAdminRequest({
      method: 'GET',
      host: HOST,
      pathWithQuery: PATH,
      timestamp: TS,
      nonce,
      body: EMPTY,
      privateKey: phonePair.privateKey,
      keyName: 'phone',
    });
    const replay: AdminReplayCache = new Map();
    const keys = [desk, phone] as const;
    expect(check(deskHeaders, { replay, keys })).toBe(true);
    expect(check(phoneHeaders, { replay, keys })).toBe(true);
  });

  it('rejects a missing nonce', () => {
    expect(check(sign(), { nonce: undefined })).toBe(false);
  });

  it('rejects a malformed nonce', () => {
    const headers = sign();
    expect(check(headers, { nonce: 'a'.repeat(15) })).toBe(false);
    expect(check(headers, { nonce: 'a'.repeat(65) })).toBe(false);
    expect(check(headers, { nonce: `${'a'.repeat(15)}+` })).toBe(false);
  });

  it('does not record the nonce of a rejected request', () => {
    const headers = sign();
    const replay: AdminReplayCache = new Map();
    expect(check(headers, { replay, host: 'other.example' })).toBe(false);
    expect(replay.has(`desk\n${NONCE}`)).toBe(false);
    expect(check(headers, { replay })).toBe(true);
  });
});
