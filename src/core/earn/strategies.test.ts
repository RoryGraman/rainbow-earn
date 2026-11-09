import { describe, expect, it } from 'vitest';

import {
  chartStrategies,
  chartWindows,
  combinedValueChartData,
  currentYield,
  historyStart,
  listAgrees,
  resolveStrategy,
  strategyApy,
  valueChartData,
} from './strategies';
import type { EarnStrategy } from './types';

const row = (id: string, status: string, chain_id = 8453): EarnStrategy => ({
  id,
  wallet_address: '0xabc',
  name: 'x',
  capital_usdc: 1,
  status,
  chain_id,
  hidden_vault_keys: [],
  max_positions: 5,
});

const list = (strategies: EarnStrategy[]) => ({
  strategies,
  closedStrategies: [] as EarnStrategy[],
});

describe('resolveStrategy', () => {
  it('returns the first open strategy on the chain', () => {
    const data = list([
      row('a', 'closed'),
      row('b', 'active', 1),
      row('c', 'active'),
    ]);
    expect(resolveStrategy(data, null, 8453)?.id).toBe('c');
  });

  it('returns null when there is no list yet or no open strategy', () => {
    expect(resolveStrategy(undefined, null, 8453)).toBeNull();
    expect(resolveStrategy(list([row('a', 'closed')]), null, 8453)).toBeNull();
  });

  it('shows the settled strategy over a stale list row', () => {
    const data = list([row('a', 'pending_setup')]);
    const settled = { id: 'a', strategy: row('a', 'active') };
    expect(resolveStrategy(data, settled, 8453)?.status).toBe('active');
  });

  it('shows the settled strategy when the list does not have it yet', () => {
    const settled = { id: 'a', strategy: row('a', 'active') };
    expect(resolveStrategy(list([]), settled, 8453)?.id).toBe('a');
    expect(resolveStrategy(undefined, settled, 8453)?.id).toBe('a');
  });

  it('hides a settled strategy that closed or was deleted', () => {
    const data = list([row('a', 'active')]);
    expect(
      resolveStrategy(data, { id: 'a', strategy: row('a', 'closed') }, 8453),
    ).toBeNull();
    expect(resolveStrategy(data, { id: 'a', strategy: null }, 8453)).toBeNull();
  });
});

describe('listAgrees', () => {
  it('agrees when the list row has the settled status', () => {
    const settled = { id: 'a', strategy: row('a', 'active') };
    expect(listAgrees(list([row('a', 'active')]), settled)).toBe(true);
    expect(listAgrees(list([row('a', 'pending_setup')]), settled)).toBe(false);
    expect(listAgrees(list([]), settled)).toBe(false);
  });

  it('agrees on a closed or deleted strategy once the open list drops it', () => {
    const closed = { id: 'a', strategy: row('a', 'closed') };
    const deleted = { id: 'a', strategy: null };
    expect(listAgrees(list([row('a', 'active')]), closed)).toBe(false);
    expect(listAgrees(list([]), closed)).toBe(true);
    expect(listAgrees(list([row('a', 'active')]), deleted)).toBe(false);
    expect(listAgrees(list([]), deleted)).toBe(true);
  });

  // After an increase, the cached list can still hold the old value.
  it('waits for the list to show the settled value, within 1 USDC', () => {
    const settled = {
      id: 'a',
      strategy: { ...row('a', 'active'), net_value_usdc: 650 },
    };
    const at = (net_value_usdc: number) =>
      list([{ ...row('a', 'active'), net_value_usdc }]);
    expect(listAgrees(at(600), settled)).toBe(false);
    expect(listAgrees(at(650.4), settled)).toBe(true);
  });

  // On a large strategy, yield alone can move the value more than 1 USDC.
  it('takes a list fetched 10 s after the run as current, whatever its value', () => {
    const settled = {
      id: 'a',
      at: 50_000,
      strategy: { ...row('a', 'active'), net_value_usdc: 10_000_000 },
    };
    const moved = list([{ ...row('a', 'active'), net_value_usdc: 10_000_003 }]);
    expect(listAgrees(moved, settled, 55_000)).toBe(false);
    expect(listAgrees(moved, settled, 60_000)).toBe(true);
  });
});

const withValue = (extra: Partial<EarnStrategy>): EarnStrategy => ({
  ...row('a', 'active'),
  capital_usdc: 1000,
  ...extra,
});

describe('currentYield', () => {
  it('uses contributed and withdrawn when there is no snapshot', () => {
    expect(
      currentYield(
        withValue({
          net_value_usdc: 450,
          contributed_usdc: 600,
          withdrawn_usdc: 160,
        }),
        null,
      ),
    ).toBeCloseTo(10);
  });

  // The snapshot can be an hour old and disagree with the live value.
  it('prefers the live value and lifetime totals over a snapshot', () => {
    const latest = {
      cumulative_yield: 0.05,
      weighted_apy: 4.9,
      total_value_usdc: 500.05,
      snapshot_at: '2026-11-03T00:00:30Z',
    };
    expect(
      currentYield(
        withValue({
          net_value_usdc: 700.08,
          contributed_usdc: 700,
          withdrawn_usdc: 0,
        }),
        latest,
      ),
    ).toBeCloseTo(0.08, 6);
  });

  it('uses the cumulative yield of the latest snapshot without the totals', () => {
    const latest = {
      cumulative_yield: 24.71,
      weighted_apy: 5.8,
      total_value_usdc: 1024.71,
      snapshot_at: '2026-10-30T09:00:00Z',
    };
    expect(currentYield(withValue({ net_value_usdc: 1500 }), latest)).toBe(
      24.71,
    );
    expect(currentYield(withValue({}), latest)).toBe(24.71);
  });

  it('falls back to value minus deposited when there is no snapshot yet', () => {
    expect(
      currentYield(withValue({ net_value_usdc: 1003.5 }), null),
    ).toBeCloseTo(3.5, 6);
    expect(
      currentYield(withValue({ total_value_usdc: 998 }), undefined),
    ).toBeCloseTo(-2, 6);
  });

  it('rounds to cents, so vault rounding dust shows as zero', () => {
    const dust = currentYield(
      withValue({
        net_value_usdc: 699.999999,
        contributed_usdc: 700,
        withdrawn_usdc: 0,
      }),
      null,
    );
    expect(dust).toBe(0);
    expect(Object.is(dust, -0)).toBe(false);
    expect(
      currentYield(
        withValue({
          net_value_usdc: 1000.1,
          contributed_usdc: 1000.3,
          withdrawn_usdc: 0.2,
        }),
        null,
      ),
    ).toBe(0);
  });

  it('ignores a total that arrives as null', () => {
    const latest = {
      cumulative_yield: 0.05,
      weighted_apy: 4.9,
      total_value_usdc: 500.05,
      snapshot_at: 'x',
    };
    expect(
      currentYield(
        withValue({
          net_value_usdc: 700,
          contributed_usdc: null as unknown as number,
          withdrawn_usdc: 0,
        }),
        latest,
      ),
    ).toBe(0.05);
  });

  it('is null when no value is known', () => {
    expect(currentYield(withValue({}), null)).toBeNull();
  });
});

describe('strategyApy', () => {
  const position = (usdc_value: number, entry_apy: number) => ({
    id: String(entry_apy),
    vault_name: 'v',
    vault_address: '0x1',
    chain_id: 8453,
    usdc_value,
    entry_apy,
  });

  it('prefers the realized APY', () => {
    expect(strategyApy(withValue({ realized_apy: 5.1 }), null)).toBe(5.1);
  });

  it('then the weighted APY of the latest snapshot', () => {
    const latest = {
      cumulative_yield: 1,
      weighted_apy: 4.2,
      total_value_usdc: 1,
      snapshot_at: 'x',
    };
    expect(strategyApy(withValue({ realized_apy: null }), latest)).toBe(4.2);
  });

  it('then the value-weighted entry APY of the positions', () => {
    const s = withValue({
      realized_apy: null,
      positions: [position(300, 4), position(100, 8)],
    });
    expect(strategyApy(s, null)).toBeCloseTo(5, 6);
  });

  it('is null with nothing to go on', () => {
    expect(strategyApy(withValue({ realized_apy: null }), null)).toBeNull();
  });
});

describe('valueChartData', () => {
  const snap = (snapshot_at: string, total_value_usdc: number) => ({
    snapshot_at,
    total_value_usdc,
    cumulative_yield: 0,
    weighted_apy: 5,
  });
  const at = (ms: number) => new Date(ms).toISOString();

  it('starts at zero before the position opened, then follows the value', () => {
    const data = valueChartData([snap(at(40), 500), snap(at(80), 502)], {
      from: 0,
      to: 100,
      startedAt: 30,
      currentValue: 503,
      buckets: 4,
    });
    expect(data).toEqual([
      { timestamp: 0, value: 0 },
      { timestamp: 25, value: 0 },
      { timestamp: 50, value: 500.5 },
      { timestamp: 75, value: 501.75 },
      { timestamp: 100, value: 503 },
    ]);
  });

  it('holds the first value when the position opened before the range', () => {
    const data = valueChartData([snap(at(10), 1000), snap(at(60), 900)], {
      from: 0,
      to: 100,
      startedAt: -500,
      currentValue: 901,
      buckets: 2,
    });
    expect(data).toEqual([
      { timestamp: 0, value: 1000 },
      { timestamp: 50, value: 920 },
      { timestamp: 100, value: 901 },
    ]);
  });

  it('skips bad rows and still ends at the current value', () => {
    const data = valueChartData(
      [snap('not a date', 7), snap(at(50), Number.NaN)],
      { from: 0, to: 100, currentValue: 42, buckets: 1 },
    );
    expect(data).toEqual([
      { timestamp: 0, value: 42 },
      { timestamp: 100, value: 42 },
    ]);
  });
});

describe('chartWindows', () => {
  it('shows the ranges up to the first one that covers the age', () => {
    expect(chartWindows(5)).toEqual({ shown: [24], initial: 24 });
    expect(chartWindows(30)).toEqual({ shown: [24, 168], initial: 168 });
    expect(chartWindows(24 * 200)).toEqual({
      shown: [24, 168, 720, 2160],
      initial: 2160,
    });
  });

  it('shows every range when the age is unknown', () => {
    expect(chartWindows(null)).toEqual({
      shown: [24, 168, 720, 2160],
      initial: 168,
    });
  });
});

describe('history chart across strategies', () => {
  const snap = (snapshot_at: string, total_value_usdc: number) => ({
    snapshot_at,
    total_value_usdc,
    cumulative_yield: 0,
    weighted_apy: 5,
  });
  const at = (ms: number) => new Date(ms).toISOString();
  const earn = (id: string, extra: Partial<EarnStrategy> = {}) => ({
    ...row(id, 'active'),
    name: 'Rainbow Earn',
    ...extra,
  });

  it('holds a closed strategy at its final value until it closed, then zero', () => {
    const data = valueChartData([snap(at(20), 500)], {
      from: 0,
      to: 100,
      startedAt: 10,
      endedAt: 50,
      currentValue: 501,
      buckets: 4,
    });
    expect(data.map((p) => p.value)).toEqual([
      0,
      expect.closeTo(500.1667, 3),
      501,
      0,
      0,
    ]);
  });

  it('lists the Rainbow Earn strategies of the chain that overlap the range', () => {
    const open = earn('open', { first_deposit_at: at(60) });
    const closed = earn('closed', {
      status: 'closed',
      first_deposit_at: at(10),
      deactivated_at: at(50),
    });
    const tooOld = earn('old', { status: 'closed', deactivated_at: at(5) });
    const web = {
      ...earn('web', { status: 'closed', deactivated_at: at(40) }),
      name: 'My web strategy',
    };
    const otherChain = earn('arb', {
      status: 'closed',
      chain_id: 42161,
      deactivated_at: at(40),
    });
    const data = {
      strategies: [open],
      closedStrategies: [closed, tooOld, web, otherChain],
    };
    expect(chartStrategies(data, open, 8453, 20).map((s) => s.id)).toEqual([
      'open',
      'closed',
    ]);
  });

  it('keeps the open strategy once, whatever its name', () => {
    const open = { ...earn('s1'), name: 'Made on the web' };
    const data = { strategies: [open], closedStrategies: [] };
    expect(chartStrategies(data, open, 8453, 0).map((s) => s.id)).toEqual([
      's1',
    ]);
  });

  const valueAt = (data: { timestamp: number; value: number }[], t: number) =>
    data.find((p) => p.timestamp === t)?.value;

  it('adds the strategies together, with zero between them', () => {
    const data = combinedValueChartData(
      [
        {
          snapshots: [snap(at(10), 100)],
          startedAt: 10,
          endedAt: 40,
          currentValue: 100,
        },
        { snapshots: [snap(at(60), 200)], startedAt: 60, currentValue: 200 },
      ],
      { from: 0, to: 100, buckets: 4 },
    );
    expect([0, 25, 50, 75, 100].map((t) => valueAt(data, t))).toEqual([
      0, 100, 0, 200, 200,
    ]);
    // Sharp edges: points at each open and close, and just outside them.
    expect([9, 10, 40, 41, 59, 60].map((t) => valueAt(data, t))).toEqual([
      0, 100, 100, 0, 0, 200,
    ]);
    expect(data.map((p) => p.timestamp)).toEqual(
      [...data.map((p) => p.timestamp)].sort((a, b) => a - b),
    );
  });

  it('shows a strategy shorter than one step of the grid', () => {
    const data = combinedValueChartData(
      [
        {
          snapshots: [],
          startedAt: 30,
          endedAt: 32,
          currentValue: 500,
        },
      ],
      { from: 0, to: 100, buckets: 4 },
    );
    expect(Math.max(...data.map((p) => p.value))).toBe(500);
  });

  it('leaves out a closed strategy without a close time', () => {
    const open = earn('open');
    const data = {
      strategies: [open],
      closedStrategies: [earn('nodate', { status: 'closed' })],
    };
    expect(chartStrategies(data, open, 8453, 0).map((s) => s.id)).toEqual([
      'open',
    ]);
  });

  it('starts the history at the first strategy', () => {
    expect(
      historyStart([
        earn('a', { first_deposit_at: at(30) }),
        earn('b', { created_at: at(10) }),
      ]),
    ).toBe(10);
    expect(historyStart([])).toBeUndefined();
  });
});
