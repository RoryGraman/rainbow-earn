import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { Address, erc20Abi, formatUnits } from 'viem';

import { createEarnApi } from '~/core/earn/api';
import {
  EARN_ENVIRONMENTS,
  USDC_BASE_ADDRESS,
  USDC_DECIMALS,
} from '~/core/earn/defaults';
import {
  type PerformancePoint,
  listAgrees,
  resolveStrategy,
} from '~/core/earn/strategies';
import type { EarnStrategy, EarnVault } from '~/core/earn/types';
import {
  pickVisibleVaults,
  rankedVaults,
  visibleVaultsOf,
  withoutHiddenVaults,
} from '~/core/earn/vaults';
import { useEarnStore } from '~/core/state/earn';
import { useEarnRunStore } from '~/core/state/earn/run';
import { getViemClient } from '~/core/viem/clients';

export function useEarnApi() {
  const environment = useEarnStore((s) => s.settings.environment);
  return useMemo(
    () => createEarnApi(EARN_ENVIRONMENTS[environment]),
    [environment],
  );
}

export function useEarnConfig() {
  const api = useEarnApi();
  const environment = useEarnStore((s) => s.settings.environment);
  return useQuery({
    queryKey: ['earn', 'config', environment],
    queryFn: () => api.getConfig(),
    staleTime: 5 * 60_000,
  });
}

export function useUsdcBalance(
  address: Address,
  chainId: number,
  enabled = true,
) {
  return useQuery({
    enabled,
    queryKey: ['earn', 'usdc-balance', address, chainId],
    queryFn: async () => {
      const raw = await getViemClient({ chainId }).readContract({
        address: USDC_BASE_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      });
      return Number(formatUnits(raw, USDC_DECIMALS));
    },
    refetchInterval: 15_000,
  });
}

// Same rules as the flow. A resume uses the strategy's own settings, not
// today's, because it funds the strategy as it was made. The server drops a
// vault whose capacity is below the amount per vault, so rank for the amount.
export function useTopVaults(
  address: Address,
  pending: EarnStrategy | null,
  capitalUsdc: number,
) {
  const api = useEarnApi();
  const environment = useEarnStore((s) => s.settings.environment);
  const chainId = useEarnStore((s) => s.settings.chainId);
  const vaultCount = useEarnStore((s) => s.settings.vaultCount);
  const minTvlUsd = useEarnStore((s) => s.settings.minTvlUsd);
  const minLiquidityUsd = useEarnStore((s) => s.settings.minLiquidityUsd);
  const apyWindow = useEarnStore((s) => s.settings.apySmoothingMinutes);

  // The amount comes last, so the placeholder check can leave it out.
  const queryKey = [
    'earn',
    'vaults',
    environment,
    address,
    chainId,
    pending?.id ?? null,
    vaultCount,
    minTvlUsd,
    minLiquidityUsd,
    apyWindow,
    capitalUsdc,
  ];

  return useQuery({
    queryKey,
    queryFn: async () => {
      const window = pending?.apy_smoothing_minutes ?? apyWindow;
      const count = pending?.max_positions ?? vaultCount;
      const [vaults, prefs] = await Promise.all([
        api.listVaults(chainId, window),
        api.getPrefs(address),
      ]);
      const globalHidden = prefs.hidden_vault_keys ?? [];
      let visible: EarnVault[];
      let hiddenKeys: string[];
      if (pending) {
        hiddenKeys = [...pending.hidden_vault_keys, ...globalHidden];
        visible = visibleVaultsOf(vaults, chainId, hiddenKeys);
      } else {
        const pick = pickVisibleVaults(
          withoutHiddenVaults(vaults, globalHidden),
          chainId,
          vaultCount,
          { minTvlUsd, minLiquidityUsd },
        );
        visible = pick.visible;
        hiddenKeys = [...pick.hiddenKeys, ...globalHidden];
      }
      const ranked = await api.rankVaults({
        chainId,
        capitalUsdc: pending?.capital_usdc ?? capitalUsdc,
        maxPositions: count,
        minTvlUsd: pending?.min_tvl_usd ?? minTvlUsd,
        minLiquidityUsd: pending?.min_liquidity_usd ?? minLiquidityUsd,
        minLiquidityMultiplier: pending?.min_liquidity_entry_multiplier,
        apySmoothingMinutes: window,
        hiddenKeys,
        wallet: address,
      });
      return { selected: rankedVaults(visible, ranked), count };
    },
    refetchInterval: 60_000,
    // Only a new amount keeps the last list on screen while it is ranked.
    placeholderData: (previous, previousQuery) =>
      previousQuery &&
      JSON.stringify(previousQuery.queryKey.slice(0, -1)) ===
        JSON.stringify(queryKey.slice(0, -1))
        ? previous
        : undefined,
  });
}

export function useEarnStrategy(address: Address) {
  const api = useEarnApi();
  const environment = useEarnStore((s) => s.settings.environment);
  const chainId = useEarnStore((s) => s.settings.chainId);
  const settledRun = useEarnRunStore((s) => s.settled);
  const setSettled = useEarnRunStore((s) => s.setSettled);
  const settled =
    settledRun && settledRun.wallet === address.toLowerCase()
      ? settledRun
      : null;

  const query = useQuery({
    queryKey: ['earn', 'strategies', environment, address],
    queryFn: () => api.listStrategies(address),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    if (
      settled &&
      query.data &&
      listAgrees(query.data, settled, query.dataUpdatedAt)
    ) {
      setSettled(null);
    }
  }, [query.data, query.dataUpdatedAt, settled, setSettled]);

  const strategy = useMemo(
    () => resolveStrategy(query.data, settled, chainId),
    [query.data, settled, chainId],
  );
  return { ...query, strategy };
}

export function useLatestPerformance(strategyId: string | undefined) {
  const api = useEarnApi();
  const environment = useEarnStore((s) => s.settings.environment);
  return useQuery({
    queryKey: ['earn', 'performance', environment, strategyId],
    queryFn: () => api.getLatestPerformance(strategyId as string),
    enabled: !!strategyId,
    refetchInterval: 60_000,
  });
}

export function usePerformanceSeries(strategyId: string, hours: number) {
  const api = useEarnApi();
  const environment = useEarnStore((s) => s.settings.environment);
  return useQuery({
    queryKey: ['earn', 'performance-series', environment, strategyId, hours],
    queryFn: () => api.getPerformance(strategyId, hours),
    placeholderData: (previous) => previous,
    refetchInterval: 5 * 60_000,
  });
}

// Closed snapshots never change: read once per range, never on a timer, and a
// key of their own keeps them out of the refresh after each job. A failed read
// leaves that strategy flat at its final value until a later read.
export function useClosedSeries(strategyIds: string[], hours: number) {
  const api = useEarnApi();
  const environment = useEarnStore((s) => s.settings.environment);
  return useQuery({
    queryKey: ['earn', 'closed-series', environment, strategyIds, hours],
    queryFn: async () => {
      const results = await Promise.allSettled(
        strategyIds.map((id) => api.getPerformance(id, hours)),
      );
      return Object.fromEntries(
        strategyIds.map((id, i) => {
          const result = results[i];
          return [id, result.status === 'fulfilled' ? result.value : undefined];
        }),
      ) as Record<string, PerformancePoint[] | undefined>;
    },
    enabled: strategyIds.length > 0,
    placeholderData: keepPreviousData,
    staleTime: (query) =>
      Object.values(query.state.data ?? {}).includes(undefined) ? 0 : Infinity,
  });
}

// Prices the review fee when Rainbow's asset service has no price.
export function useNativePrices() {
  const api = useEarnApi();
  const environment = useEarnStore((s) => s.settings.environment);
  return useQuery({
    queryKey: ['earn', 'native-prices', environment],
    queryFn: () => api.getNativePrices(),
    staleTime: 60_000,
  });
}

// Read fresh each time the sheet opens.
export function useWithdrawQuote(strategyId: string, enabled: boolean) {
  const api = useEarnApi();
  const environment = useEarnStore((s) => s.settings.environment);
  return useQuery({
    queryKey: ['earn', 'withdraw-quote', environment, strategyId],
    queryFn: () => api.getWithdrawQuote(strategyId),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
