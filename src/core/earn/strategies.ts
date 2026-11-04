import { EARN_STRATEGY_NAME } from './defaults';
import type { EarnStrategy } from './types';

export type StrategyList = {
  strategies: EarnStrategy[];
  closedStrategies: EarnStrategy[];
};

// The strategy a finished run left behind. `strategy: null` means deleted.
// `at` is when the run left it, in ms.
export type SettledStrategy = {
  id: string;
  strategy: EarnStrategy | null;
  at?: number;
};

// The server caches the list for 8 s. A list fetched later than this after a
// run shows the run's result.
const LIST_CURRENT_AFTER_MS = 10_000;

// The list endpoint is cached on the server for a few seconds, so right after
// a run it can still show the old state. The settled strategy wins until the
// list catches up.
export function resolveStrategy(
  data: StrategyList | undefined,
  settled: SettledStrategy | null,
  chainId: number,
): EarnStrategy | null {
  let rows = data?.strategies ?? [];
  if (settled) {
    rows = rows.filter((row) => row.id !== settled.id);
    if (settled.strategy) rows = [settled.strategy, ...rows];
  }
  return (
    rows.find((row) => row.chain_id === chainId && row.status !== 'closed') ??
    null
  );
}

export function listAgrees(
  data: StrategyList | undefined,
  settled: SettledStrategy,
  fetchedAt?: number,
): boolean {
  const row = data?.strategies.find((r) => r.id === settled.id);
  if (!settled.strategy || settled.strategy.status === 'closed') return !row;
  // An increase or decrease keeps the status, so the value must agree too:
  // within 1 USDC, or in a list fetched after the cache ran out, because
  // yield keeps moving the value.
  const listed = row?.net_value_usdc;
  const fresh = settled.strategy.net_value_usdc;
  const current =
    fetchedAt !== undefined &&
    settled.at !== undefined &&
    fetchedAt - settled.at >= LIST_CURRENT_AFTER_MS;
  return (
    row?.status === settled.strategy.status &&
    (current ||
      listed === undefined ||
      fresh === undefined ||
      Math.abs(listed - fresh) < 1)
  );
}

// The latest value and yield snapshot of a strategy. The server writes one
// about every hour.
export type PerformancePoint = {
  cumulative_yield: number;
  weighted_apy: number | null;
  total_value_usdc: number;
  snapshot_at: string;
};

// Yield earned so far, in USDC: the live value plus withdrawn minus
// contributed, so it always agrees with the value shown beside it. The
// hourly snapshot's figure is only a fallback, because it can be an hour old.
// Rounded to cents, so vault rounding dust never shows as a red -$0.00.
export function currentYield(
  strategy: EarnStrategy,
  latest?: PerformancePoint | null,
): number | null {
  const finite = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n);
  const cents = (n: number) => Math.round(n * 100) / 100 + 0;
  const value = strategy.net_value_usdc ?? strategy.total_value_usdc;
  const { contributed_usdc: contributed, withdrawn_usdc: withdrawn } = strategy;
  if (finite(value) && finite(contributed) && finite(withdrawn)) {
    return cents(value + withdrawn - contributed);
  }
  if (latest && finite(latest.cumulative_yield)) {
    return cents(latest.cumulative_yield);
  }
  if (!finite(value)) return null;
  return cents(value - strategy.capital_usdc);
}

export type ValuePoint = { timestamp: number; value: number };

type ValueSpan = {
  to: number;
  startedAt?: number;
  endedAt?: number;
  currentValue: number;
};

// One strategy's value at any time (ms): zero before it opened and after it
// closed (`endedAt`), interpolated between snapshots, and ending at the value
// now, or at the final value at the close.
function valueAtTime(
  snapshots: PerformancePoint[] | undefined,
  { to, startedAt, endedAt, currentValue }: ValueSpan,
): (t: number) => number {
  const end = endedAt ?? to;
  const known = (snapshots ?? [])
    .map((s) => ({
      timestamp: Date.parse(s.snapshot_at),
      value: s.total_value_usdc,
    }))
    .filter(
      (p) =>
        Number.isFinite(p.timestamp) &&
        Number.isFinite(p.value) &&
        p.timestamp < end,
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  known.push({ timestamp: end, value: currentValue });

  return (t: number) => {
    if (startedAt !== undefined && t < startedAt) return 0;
    if (endedAt !== undefined && t > endedAt) return 0;
    if (t <= known[0].timestamp) return known[0].value;
    const next = known.findIndex((p) => p.timestamp >= t);
    const b = known[next];
    const a = known[next - 1];
    return (
      a.value +
      ((t - a.timestamp) / (b.timestamp - a.timestamp)) * (b.value - a.value)
    );
  };
}

const evenGrid = (from: number, to: number, buckets: number) =>
  Array.from(
    { length: buckets + 1 },
    (_, i) => from + (i * (to - from)) / buckets,
  );

// The position value on an even time grid from `from` to `to` (ms), so the
// chart's x-axis is real time.
export function valueChartData(
  snapshots: PerformancePoint[] | undefined,
  { from, buckets, ...span }: ValueSpan & { from: number; buckets: number },
): ValuePoint[] {
  const valueAt = valueAtTime(snapshots, span);
  return evenGrid(from, span.to, buckets).map((timestamp) => ({
    timestamp,
    value: valueAt(timestamp),
  }));
}

export type ChartEntry = {
  snapshots: PerformancePoint[] | undefined;
  startedAt?: number;
  endedAt?: number;
  currentValue: number;
};

// Several strategies added together. Between two of them the sum is zero,
// because nothing was invested. Each open and close, and 1 ms outside it, is
// a point of its own, so the edges are sharp and a strategy shorter than one
// step of the even grid still shows.
export function combinedValueChartData(
  entries: ChartEntry[],
  { from, to, buckets }: { from: number; to: number; buckets: number },
): ValuePoint[] {
  const times = new Set(evenGrid(from, to, buckets));
  for (const { startedAt, endedAt } of entries) {
    for (const t of [
      startedAt === undefined ? undefined : startedAt - 1,
      startedAt,
      endedAt,
      endedAt === undefined ? undefined : endedAt + 1,
    ]) {
      if (t !== undefined && t > from && t < to) times.add(t);
    }
  }
  const valueAts = entries.map(({ snapshots, ...span }) =>
    valueAtTime(snapshots, { to, ...span }),
  );
  return [...times]
    .sort((a, b) => a - b)
    .map((timestamp) => ({
      timestamp,
      value: valueAts.reduce((sum, valueAt) => sum + valueAt(timestamp), 0),
    }));
}

// What the chart shows: the open strategy, and every closed strategy this
// wallet made on the chain that closed after `from` (ms). A closed row
// without a close time is left out.
export function chartStrategies(
  data: StrategyList | undefined,
  open: EarnStrategy,
  chainId: number,
  from: number,
): EarnStrategy[] {
  const closed = (data?.closedStrategies ?? []).filter((s) => {
    const ended = Date.parse(s.deactivated_at ?? '');
    return (
      s.id !== open.id &&
      s.status === 'closed' &&
      s.chain_id === chainId &&
      s.name === EARN_STRATEGY_NAME &&
      Number.isFinite(ended) &&
      ended >= from
    );
  });
  return [open, ...closed];
}

const openedAt = (s: EarnStrategy) =>
  Date.parse(s.first_deposit_at ?? s.created_at ?? '');

// When the first of these strategies opened, in ms.
export function historyStart(strategies: EarnStrategy[]): number | undefined {
  const times = strategies.map(openedAt).filter(Number.isFinite);
  return times.length > 0 ? Math.min(...times) : undefined;
}

export const CHART_WINDOW_HOURS = [24, 168, 720, 2160];

// The chart ranges worth showing for a position of this age: each range up to
// the first one that covers the whole position. That one opens first.
export function chartWindows(ageHours: number | null) {
  if (ageHours === null) return { shown: CHART_WINDOW_HOURS, initial: 168 };
  const fit = CHART_WINDOW_HOURS.findIndex((hours) => hours >= ageHours);
  const shown =
    fit === -1 ? CHART_WINDOW_HOURS : CHART_WINDOW_HOURS.slice(0, fit + 1);
  return { shown, initial: shown[shown.length - 1] };
}

// The APY to show. Realized APY first, then the latest snapshot, then the
// value-weighted APY the positions were entered at.
export function strategyApy(
  strategy: EarnStrategy,
  latest?: PerformancePoint | null,
): number | null {
  if (strategy.realized_apy !== null && strategy.realized_apy !== undefined) {
    return strategy.realized_apy;
  }
  if (latest?.weighted_apy !== null && latest?.weighted_apy !== undefined) {
    return latest.weighted_apy;
  }
  const positions = strategy.positions ?? [];
  const total = positions.reduce((sum, p) => sum + p.usdc_value, 0);
  if (total <= 0) return null;
  return (
    positions.reduce((sum, p) => sum + p.entry_apy * p.usdc_value, 0) / total
  );
}
