import type { EarnVault } from './types';

export const vaultKey = (chainId: number, address: string) =>
  `${chainId}:${address.toLowerCase()}`;

const keyOf = (vault: EarnVault) => vaultKey(vault.chainId, vault.vaultAddress);

// The server asks for twice the liquidity floor before it enters a vault.
const ENTRY_LIQUIDITY_MULTIPLIER = 2;

// The server rejects a hide list that leaves under max_positions + 1 eligible.
const EXTRA_VISIBLE_VAULTS = 1;

const bySize = (a: EarnVault, b: EarnVault) =>
  b.tvlUsd - a.tvlUsd || a.name.localeCompare(b.name);

const hasPositiveApy = (vault: EarnVault) =>
  vault.apy !== null && vault.apy > 0;

// The server merges the wallet's global hide list into every strategy, so the
// client must not count those vaults.
export function withoutHiddenVaults(
  vaults: EarnVault[],
  hiddenKeys: Iterable<string>,
): EarnVault[] {
  const hidden = new Set([...hiddenKeys].map((key) => key.toLowerCase()));
  return vaults.filter((vault) => !hidden.has(keyOf(vault)));
}

// The deposit endpoint picks vaults itself. To steer it, every vault outside
// the N + 1 largest goes in the hide list; it enters the N best by APY.
// The N + 1 rule counts only vaults past the server's TVL, liquidity and
// positive-APY stages (ranking-stages.ts), so hiding any other is allowed. A
// vault at capacity still counts, so it may fill a slot when too few are open.
export function pickVisibleVaults(
  vaults: EarnVault[],
  chainId: number,
  count: number,
  floors: { minTvlUsd?: number; minLiquidityUsd?: number } = {},
): { visible: EarnVault[]; hiddenKeys: string[] } {
  const minTvl = floors.minTvlUsd ?? 0;
  const minLiquidity =
    (floors.minLiquidityUsd ?? 0) * ENTRY_LIQUIDITY_MULTIPLIER;
  const onChain = vaults.filter((vault) => vault.chainId === chainId);

  // A vault with no liquidity reading fails a liquidity floor, as on the server.
  const eligible = onChain
    .filter(
      (vault) =>
        hasPositiveApy(vault) &&
        vault.tvlUsd >= minTvl &&
        (minLiquidity <= 0 ||
          (vault.availableLiquidityUsd !== null &&
            vault.availableLiquidityUsd >= minLiquidity)),
    )
    .sort(bySize);

  const visible = [
    ...eligible.filter((vault) => !vault.atCapacity),
    ...eligible.filter((vault) => vault.atCapacity),
  ].slice(0, count + EXTRA_VISIBLE_VAULTS);
  const shown = new Set(visible.map(keyOf));
  // The list rounds APY to 2 decimals. A 0.00 vault can still be positive on
  // the server and count there, so it is never hidden.
  const hiddenKeys = onChain
    .filter((vault) => !shown.has(keyOf(vault)) && vault.apy !== 0)
    .map(keyOf);
  return { visible, hiddenKeys };
}

export function rankedVaults(
  visible: EarnVault[],
  rankedKeys: string[],
): EarnVault[] {
  const ranked = new Set(rankedKeys.map((key) => key.toLowerCase()));
  return visible.filter((vault) => ranked.has(keyOf(vault))).sort(bySize);
}

// `hiddenKeys` is the strategy's hide list plus the wallet's global one.
export function visibleVaultsOf(
  vaults: EarnVault[],
  chainId: number,
  hiddenKeys: string[],
): EarnVault[] {
  return withoutHiddenVaults(
    vaults.filter((vault) => vault.chainId === chainId),
    hiddenKeys,
  ).sort(bySize);
}

// A short address for each vault whose name repeats. Null for a unique name.
export function repeatedNameDetails(
  vaults: { name: string; address: string }[],
): (string | null)[] {
  const same = (name: string) => name.trim().toLowerCase();
  const counts = new Map<string, number>();
  vaults.forEach(({ name }) =>
    counts.set(same(name), (counts.get(same(name)) ?? 0) + 1),
  );
  return vaults.map(({ name, address }) => {
    if ((counts.get(same(name)) ?? 0) < 2) return null;
    const lower = address.toLowerCase();
    return `${lower.slice(0, 6)}…${lower.slice(-4)}`;
  });
}
