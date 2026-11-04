import { describe, expect, it } from 'vitest';

import { earnRpcOverride } from './rpc';

describe('earnRpcOverride', () => {
  it('returns the configured URL for Base', () => {
    expect(
      earnRpcOverride(8453, 'https://base.example.quiknode.pro/key/'),
    ).toBe('https://base.example.quiknode.pro/key/');
  });

  it('leaves every other chain alone', () => {
    expect(earnRpcOverride(1, 'https://base.example.quiknode.pro/key/')).toBe(
      undefined,
    );
    expect(earnRpcOverride(10, 'https://base.example.quiknode.pro/key/')).toBe(
      undefined,
    );
  });

  it('does nothing when no URL is configured', () => {
    expect(earnRpcOverride(8453, undefined)).toBeUndefined();
    expect(earnRpcOverride(8453, '')).toBeUndefined();
    expect(earnRpcOverride(8453, '   ')).toBeUndefined();
  });

  it('refuses a URL that is not https, because the extension CSP would block it', () => {
    expect(earnRpcOverride(8453, 'http://base.example.com')).toBeUndefined();
    expect(earnRpcOverride(8453, 'not a url')).toBeUndefined();
  });
});
