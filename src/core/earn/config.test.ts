import { describe, expect, it } from 'vitest';

import { minStrategyUsdc } from './config';

const config = {
  chains: [
    { chainId: 8453, name: 'Base', minStrategyUsdc: 500 },
    { chainId: 10, name: 'Optimism', minStrategyUsdc: 250 },
  ],
};

describe('minStrategyUsdc', () => {
  it('returns the minimum the config lists for the chain', () => {
    expect(minStrategyUsdc(config, 10)).toBe(250);
    expect(minStrategyUsdc(config, 8453)).toBe(500);
  });

  it('falls back to the Base minimum when the chain or config is missing', () => {
    expect(minStrategyUsdc(config, 999)).toBe(500);
    expect(minStrategyUsdc(undefined, 8453)).toBe(500);
  });
});
