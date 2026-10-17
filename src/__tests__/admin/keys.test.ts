import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { decodeBase64, parseAdminPublicKeys } from '@/lib/admin/keys';

function rawKey(): Buffer {
  const { publicKey } = generateKeyPairSync('ed25519');
  return Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).subarray(12);
}

function sshBlob(raw: Buffer, type = 'ssh-ed25519'): Buffer {
  const kind = Buffer.from(type);
  const out = Buffer.alloc(4 + kind.length + 4 + raw.length);
  out.writeUInt32BE(kind.length, 0);
  kind.copy(out, 4);
  out.writeUInt32BE(raw.length, 4 + kind.length);
  raw.copy(out, 8 + kind.length);
  return out;
}

function b64(bytes: Buffer): string {
  return bytes.toString('base64');
}

function exportedRaw(key: ReturnType<typeof parseAdminPublicKeys>[number]): Buffer {
  return Buffer.from(key.publicKey.export({ format: 'der', type: 'spki' })).subarray(12);
}

describe('decodeBase64', () => {
  it('decodes padded and unpadded base64 and rejects invalid input', () => {
    expect(decodeBase64('YQ==')?.toString()).toBe('a');
    expect(decodeBase64('YQ')?.toString()).toBe('a');
    expect(decodeBase64('***')).toBeUndefined();
  });
});

describe('parseAdminPublicKeys', () => {
  it('parses an ed25519 line', () => {
    const raw = rawKey();
    const keys = parseAdminPublicKeys(`ed25519 ${b64(raw)} desk`);
    expect(keys.map((key) => key.name)).toEqual(['desk']);
    expect(keys[0] === undefined ? false : exportedRaw(keys[0]).equals(raw)).toBe(true);
  });

  it('parses an ssh-ed25519 blob', () => {
    const raw = rawKey();
    const keys = parseAdminPublicKeys(`ssh-ed25519 ${b64(sshBlob(raw))} desk`);
    expect(keys.map((key) => key.name)).toEqual(['desk']);
    expect(keys[0] === undefined ? false : exportedRaw(keys[0]).equals(raw)).toBe(true);
  });

  it('skips comments and blank lines', () => {
    const raw = rawKey();
    const text = `# comment\n\n  # indented\n\ned25519 ${b64(raw)} desk\n`;
    expect(parseAdminPublicKeys(text).map((key) => key.name)).toEqual(['desk']);
  });

  it('splits on CRLF', () => {
    const raw = rawKey();
    const text = `# comment\r\n\r\ned25519 ${b64(raw)} desk\r\n`;
    expect(parseAdminPublicKeys(text).map((key) => key.name)).toEqual(['desk']);
  });

  it('accepts unpadded base64', () => {
    const raw = rawKey();
    const encoded = b64(raw).replace(/=+$/u, '');
    const keys = parseAdminPublicKeys(`ed25519 ${encoded} desk`);
    expect(keys[0] === undefined ? false : exportedRaw(keys[0]).equals(raw)).toBe(true);
  });

  it('rejects the wrong token count', () => {
    expect(() => parseAdminPublicKeys('\ned25519 only')).toThrow(/line 2/);
  });

  it('rejects an unknown format', () => {
    expect(() => parseAdminPublicKeys(`rsa ${b64(rawKey())} desk`)).toThrow(/line 1/);
  });

  it('rejects a name outside the rule', () => {
    const text = `# ok\n\ned25519 ${b64(rawKey())} bad/name`;
    expect(() => parseAdminPublicKeys(text)).toThrow(/line 3/);
  });

  it('rejects a duplicate name', () => {
    const text = `ed25519 ${b64(rawKey())} desk\ned25519 ${b64(rawKey())} desk`;
    expect(() => parseAdminPublicKeys(text)).toThrow(
      /^OCP_ADMIN_PUBLIC_KEYS line 2: duplicate key name$/,
    );
  });

  it('rejects duplicate key material under another name', () => {
    const encoded = b64(rawKey());
    const text = `ed25519 ${encoded} desk\ned25519 ${encoded} laptop`;
    expect(() => parseAdminPublicKeys(text)).toThrow(
      /^OCP_ADMIN_PUBLIC_KEYS line 2: duplicate key$/,
    );
  });

  it('rejects duplicate key material in another format', () => {
    const raw = rawKey();
    const text = `ed25519 ${b64(raw)} desk\nssh-ed25519 ${b64(sshBlob(raw))} laptop`;
    expect(() => parseAdminPublicKeys(text)).toThrow(
      /^OCP_ADMIN_PUBLIC_KEYS line 2: duplicate key$/,
    );
  });

  it('rejects a key that is not 32 bytes', () => {
    const short = rawKey().subarray(0, 31);
    expect(() => parseAdminPublicKeys(`ed25519 ${b64(short)} desk`)).toThrow(/line 1/);
    expect(() => parseAdminPublicKeys(`ssh-ed25519 ${b64(sshBlob(short))} desk`)).toThrow(/line 1/);
  });

  it('rejects an ssh blob of the wrong type', () => {
    const blob = sshBlob(rawKey(), 'ssh-rsa');
    expect(() => parseAdminPublicKeys(`ssh-ed25519 ${b64(blob)} desk`)).toThrow(/line 1/);
  });

  it('rejects a truncated ssh blob', () => {
    const blob = sshBlob(rawKey());
    const head = b64(blob.subarray(0, 3));
    const cut = b64(blob.subarray(0, 20));
    expect(() => parseAdminPublicKeys(`ssh-ed25519 ${head} desk`)).toThrow(/line 1/);
    expect(() => parseAdminPublicKeys(`\nssh-ed25519 ${cut} desk`)).toThrow(/line 2/);
  });

  it('rejects an ssh blob with trailing bytes', () => {
    const blob = Buffer.concat([sshBlob(rawKey()), Buffer.from([0])]);
    expect(() => parseAdminPublicKeys(`ssh-ed25519 ${b64(blob)} desk`)).toThrow(/line 1/);
  });

  it('rejects a bad base64 alphabet', () => {
    expect(() => parseAdminPublicKeys('ed25519 ab$c desk')).toThrow(/line 1/);
  });

  it('rejects base64 whose length is 4n+1', () => {
    expect(() => parseAdminPublicKeys('ed25519 abcde desk')).toThrow(/line 1/);
  });

  it('rejects base64 with the wrong padding', () => {
    expect(() => parseAdminPublicKeys('ed25519 AAAA= desk')).toThrow(/line 1/);
  });
});
