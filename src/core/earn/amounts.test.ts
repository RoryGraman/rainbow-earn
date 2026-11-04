import { describe, expect, it } from 'vitest';

import { amountProblem, parseAmount } from './amounts';

describe('parseAmount', () => {
  it('reads a plain decimal', () => {
    expect(parseAmount('12.5')).toBe(12.5);
  });

  it('is NaN for empty or invalid text', () => {
    expect(parseAmount('')).toBeNaN();
    expect(parseAmount('.')).toBeNaN();
    expect(parseAmount('abc')).toBeNaN();
  });
});

describe('amountProblem', () => {
  const limits = { min: 10, max: 540 };

  it('accepts an amount inside the limits, including both edges', () => {
    expect(amountProblem(10, limits)).toBeNull();
    expect(amountProblem(300, limits)).toBeNull();
    expect(amountProblem(540, limits)).toBeNull();
  });

  it('says empty for nothing, zero, or NaN', () => {
    expect(amountProblem(NaN, limits)).toBe('empty');
    expect(amountProblem(0, limits)).toBe('empty');
  });

  it('says too_low under the minimum and too_high over the maximum', () => {
    expect(amountProblem(9.99, limits)).toBe('too_low');
    expect(amountProblem(540.01, limits)).toBe('too_high');
  });

  it('says too_high for any amount when the maximum is below the minimum', () => {
    expect(amountProblem(10, { min: 10, max: 5 })).toBe('too_high');
  });

  it('allows any amount over the minimum when there is no maximum', () => {
    expect(amountProblem(1_000_000, { min: 10 })).toBeNull();
  });
});
