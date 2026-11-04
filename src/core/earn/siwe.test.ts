import { describe, expect, it, vi } from 'vitest';

import { buildSiweMessage, canonicalize, payloadHash, signWrite } from './siwe';

const EMPTY_OBJECT_HASH =
  '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const NONCE = '9f2c7a1b3d4e5f60718293a4b5c6d7e8';

describe('canonicalize', () => {
  it('sorts keys at every depth and drops undefined values', () => {
    expect(
      canonicalize({ b: 1, a: { d: [3, { z: 1, y: undefined }], c: 'x' } }),
    ).toBe('{"a":{"c":"x","d":[3,{"z":1}]},"b":1}');
  });

  it('encodes primitives like JSON.stringify', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize('a')).toBe('"a"');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(12.5)).toBe('12.5');
  });
});

describe('payloadHash', () => {
  it('matches the documented hash of an empty object', () => {
    expect(payloadHash({})).toBe(EMPTY_OBJECT_HASH);
  });

  it('ignores key order', () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });
});

describe('buildSiweMessage', () => {
  it('builds the 14 line message the server expects', () => {
    const message = buildSiweMessage({
      domain: 'earn-api.quicknode.dev',
      address: ADDRESS,
      action: 'strategy.delete',
      uri: 'https://earn-api.quicknode.dev',
      chainId: 8453,
      nonce: NONCE,
      issuedAt: '2026-10-29T12:00:00.000Z',
      expiresAt: '2026-10-29T12:05:00.000Z',
      payloadHash: EMPTY_OBJECT_HASH,
      path: '/strategies/ABC?x=1',
    });
    expect(message.split('\n')).toEqual([
      'earn-api.quicknode.dev wants you to sign in with your Ethereum account:',
      ADDRESS,
      '',
      'Authorize strategy.delete',
      '',
      'URI: https://earn-api.quicknode.dev',
      'Version: 1',
      'Chain ID: 8453',
      `Nonce: ${NONCE}`,
      'Issued At: 2026-10-29T12:00:00.000Z',
      'Expiration Time: 2026-10-29T12:05:00.000Z',
      'Resources:',
      `- sha256:${EMPTY_OBJECT_HASH}`,
      '- path:/strategies/abc',
    ]);
  });
});

describe('signWrite', () => {
  const base = {
    action: 'strategy.create',
    domain: 'earn-api.quicknode.dev',
    uri: 'https://earn-api.quicknode.dev',
    chainId: 8453,
    path: '/strategies',
    address: ADDRESS as `0x${string}`,
    now: Date.parse('2026-10-29T12:00:00.000Z'),
    nonce: NONCE,
  };

  it('returns the payload with a siwe block and signs the exact message', async () => {
    const sign = vi.fn().mockResolvedValue('0xsig');
    const body = await signWrite({
      ...base,
      payload: { name: 'A', n: 1 },
      sign,
    });
    expect(sign).toHaveBeenCalledTimes(1);
    const message = sign.mock.calls[0][0] as string;
    expect(body).toEqual({
      name: 'A',
      n: 1,
      siwe: { message, signature: '0xsig' },
    });
    expect(message).toContain(`- sha256:${payloadHash({ name: 'A', n: 1 })}`);
    expect(message).toContain('Expiration Time: 2026-10-29T12:05:00.000Z');
  });

  it('uses a fresh 32 character hex nonce when none is given', async () => {
    const sign = vi.fn().mockResolvedValue('0xsig');
    await signWrite({ ...base, nonce: undefined, payload: {}, sign });
    expect(sign.mock.calls[0][0]).toMatch(/\nNonce: [0-9a-f]{32}\n/);
  });
});
