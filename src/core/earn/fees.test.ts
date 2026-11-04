import { describe, expect, it } from 'vitest';

import {
  type FeeFields,
  displayFeeUsd,
  nativeAssetForFee,
  pickedFeeFor,
  resolveFeeParams,
  sendGasLimit,
} from './fees';

type Fee = string | bigint;

const stored: FeeFields<Fee> = {
  maxFeePerGas: '100',
  maxPriorityFeePerGas: '5',
  gasPrice: '90',
};

const resolve = (request: FeeFields<Fee>, useCallerFees: boolean) =>
  resolveFeeParams<Fee>(request, stored, useCallerFees);

describe('resolveFeeParams', () => {
  it('without the opt-in, falls back to the stored fee screen values as before', () => {
    expect(resolve({}, false)).toEqual(stored);
    expect(resolve({ maxFeePerGas: '7' }, false)).toEqual({
      maxFeePerGas: '7',
      maxPriorityFeePerGas: '5',
      gasPrice: '90',
    });
  });

  it('without the opt-in, ignores a zero request fee like the old || chain', () => {
    expect(resolve({ maxPriorityFeePerGas: 0n }, false)).toEqual(stored);
  });

  it('with the opt-in and caller fees, uses only the caller fees', () => {
    expect(
      resolve({ maxFeePerGas: 20n, maxPriorityFeePerGas: 2n }, true),
    ).toEqual({
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      gasPrice: undefined,
    });
  });

  it('with the opt-in, keeps a zero priority fee instead of taking a stored one', () => {
    const fees = resolve({ maxFeePerGas: 20n, maxPriorityFeePerGas: 0n }, true);
    expect(fees.maxPriorityFeePerGas).toBe(0n);
  });

  it('with the opt-in and a legacy gas price, never adds EIP-1559 fields', () => {
    expect(resolve({ gasPrice: 30n }, true)).toEqual({
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
      gasPrice: 30n,
    });
  });

  it('with the opt-in but no caller fees, falls back to the stored values', () => {
    expect(resolve({}, true)).toEqual(stored);
  });
});

describe('displayFeeUsd', () => {
  it('shows dust as less than a cent and the rest in dollars', () => {
    expect(displayFeeUsd(0.004)).toBe('< $0.01');
    expect(displayFeeUsd(0.0119)).toBe('$0.01');
    expect(displayFeeUsd(1.234)).toBe('$1.23');
    expect(displayFeeUsd(0)).toBe('$0.00');
  });
});

describe('sendGasLimit', () => {
  it('takes the padded estimate, never below the server hint', () => {
    expect(sendGasLimit(275_000n, 310_000n)).toBe(310_000n);
    expect(sendGasLimit(340_000n, 310_000n)).toBe(340_000n);
  });

  it('takes whichever one is known', () => {
    expect(sendGasLimit(null, 310_000n)).toBe(310_000n);
    expect(sendGasLimit(undefined, 310_000n)).toBe(310_000n);
    expect(sendGasLimit(55_000n, undefined)).toBe(55_000n);
  });

  it('gives nothing, never zero, when neither is known', () => {
    expect(sendGasLimit(null, undefined)).toBeUndefined();
    expect(sendGasLimit(0n, undefined)).toBeUndefined();
    expect(sendGasLimit(0n, 0n)).toBeUndefined();
  });
});

describe('pickedFeeFor', () => {
  const eip1559 = {
    chainId: 8453,
    maxFeePerGas: '0x1312d00',
    maxPriorityFeePerGas: '0xf4240',
  };

  it('turns the picked hex fee into numbers for the same chain', () => {
    expect(pickedFeeFor(8453, eip1559)).toEqual({
      maxFeePerGas: 20_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      gasPrice: undefined,
    });
  });

  it('keeps a legacy gas price without EIP-1559 fields', () => {
    expect(pickedFeeFor(56, { chainId: 56, gasPrice: '0x3b9aca00' })).toEqual({
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
      gasPrice: 1_000_000_000n,
    });
  });

  it('gives nothing for another chain, no pick, or an empty pick', () => {
    expect(pickedFeeFor(1, eip1559)).toBeUndefined();
    expect(pickedFeeFor(8453, null)).toBeUndefined();
    expect(pickedFeeFor(8453, { chainId: 8453 })).toBeUndefined();
  });

  it('gives nothing for a pick that is not a number', () => {
    expect(
      pickedFeeFor(8453, { chainId: 8453, maxFeePerGas: 'soon' }),
    ).toBeUndefined();
  });
});

describe('nativeAssetForFee', () => {
  it('gives the symbol, 18 decimals and the price for the fee math', () => {
    expect(nativeAssetForFee('ETH', 3500)).toEqual({
      symbol: 'ETH',
      decimals: 18,
      price: { value: 3500 },
    });
  });

  it('gives nothing without a positive, finite price', () => {
    for (const usd of [
      undefined,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(nativeAssetForFee('ETH', usd)).toBeUndefined();
    }
  });
});
