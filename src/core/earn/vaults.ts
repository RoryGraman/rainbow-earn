import type { EarnVault } from './types';

export const vaultKey = (chainId: number, address: string) =>
  `${chainId}:${address.toLowerCase()}`;

const keyOf = (vault: EarnVault) => vaultKey(vault.chainId, vault.vaultAddress);

// The server asks for twice the liquidity floor before it enters a vault.
const ENTRY_LIQUIDITY_MULTIPLIER = 2;

// The server rejects a hide list that drops the eligible count below
// max_positions + 1. One extra vault stays visible to satisfy that rule.
const EXTRA_VISIBLE_VAULTS = 1;

const bySize = (a: EarnVault, b: EarnVault) =>
  b.tvlUsd - a.tvlUsd || a.name.localeCompare(b.name);

const hasPositiveApy = (vault: EarnVault) =>
  vault.apy !== null && vault.apy > 0;

// Drops the vaults a wallet hid on its global list. The server merges that
// list into every strategy, so the client must not count those vaults.
export function withoutHiddenVaults(
  vaults: EarnVault[],
  hiddenKeys: Iterable<string>,
): EarnVault[] {
  const hidden = new Set([...hiddenKeys].map((key) => key.toLowerCase()));
  return vaults.filter((vault) => !hidden.has(keyOf(vault)));
}

// The deposit endpoint chooses vaults itself. To steer it to the largest
// vaults, every vault outside the N + 1 largest stays in the strategy hide
// list. The server then enters the N of those with the best APY, after its
// capacity and allowance checks. Only the server ranking (`rankedVaults`)
// says which N: it reads APY to more decimals than the vault list.
//
// Server order (ranking-stages.ts): hidden, TVL floor, liquidity floor,
// positive APY, then capacity and allowance. The N + 1 rule counts the
// vaults left after the positive-APY stage. So a vault that fails a floor
// or has no APY never counts, and hiding it is always allowed. A vault at
// capacity still counts, so it may fill a slot when too few are open.
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

// The visible vaults the server ranked, largest first.
export function rankedVaults(
  visible: EarnVault[],
  rankedKeys: string[],
): EarnVault[] {
  const ranked = new Set(rankedKeys.map((key) => key.toLowerCase()));
  return visible.filter((vault) => ranked.has(keyOf(vault))).sort(bySize);
}

// The visible vaults of a strategy that already exists, from its own hide
// list plus the wallet's global hide list.
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

// Some vaults share a name. Each of those gets its short address, so the
// user can tell the rows apart. Null for a unique name.
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
