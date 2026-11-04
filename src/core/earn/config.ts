import { DEFAULT_MIN_STRATEGY_USDC } from './defaults';
import type { EarnConfig } from './types';

// The smallest deposit the server accepts for a chain, in whole USDC.
export function minStrategyUsdc(
  config: EarnConfig | undefined,
  chainId: number,
): number {
  return (
    config?.chains.find((chain) => chain.chainId === chainId)
      ?.minStrategyUsdc ?? DEFAULT_MIN_STRATEGY_USDC
  );
}
