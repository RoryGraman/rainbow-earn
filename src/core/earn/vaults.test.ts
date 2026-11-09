import { describe, expect, it } from 'vitest';

import type { EarnVault } from './types';
import {
  pickVisibleVaults,
  rankedVaults,
  repeatedNameDetails,
  vaultKey,
  visibleVaultsOf,
  withoutHiddenVaults,
} from './vaults';

const vault = (
  n: number,
  tvlUsd: number,
  extra: Partial<EarnVault> = {},
): EarnVault => ({
  chainId: 8453,
  vaultAddress: `0x${n.toString(16).padStart(40, 'A')}`,
  name: `Vault ${n}`,
  apy: 5,
  tvlUsd,
  availableLiquidityUsd: tvlUsd,
  maxDepositUsd: null,
  atCapacity: false,
  ...extra,
});

const names = (list: EarnVault[]) => list.map((v) => v.name);

describe('vaultKey', () => {
  it('lowercases the address', () => {
    expect(vaultKey(8453, '0xABC')).toBe('8453:0xabc');
  });
});

describe('pickVisibleVaults', () => {
  const vaults = [
    vault(1, 100),
    vault(2, 900),
    vault(3, 500),
    vault(4, 700),
    vault(5, 300),
    vault(6, 800),
    vault(7, 200),
  ];

  it('keeps the N + 1 largest vaults visible, largest first', () => {
    const { visible } = pickVisibleVaults(vaults, 8453, 5);
    expect(names(visible)).toEqual([
      'Vault 2',
      'Vault 6',
      'Vault 4',
      'Vault 3',
      'Vault 5',
      'Vault 7',
    ]);
  });

  it('hides every other vault on the chain, lowercased', () => {
    const { hiddenKeys } = pickVisibleVaults(vaults, 8453, 5);
    expect(hiddenKeys).toEqual([vaultKey(8453, vaults[0].vaultAddress)]);
    hiddenKeys.forEach((key) => expect(key).toBe(key.toLowerCase()));
  });

  it('skips vaults without a positive APY, because the server will not enter them', () => {
    const list = [
      vault(90, 9999, { apy: null }),
      vault(91, 9998, { apy: 0 }),
      vault(92, 9997, { apy: -1 }),
      ...vaults,
    ];
    const { visible, hiddenKeys } = pickVisibleVaults(list, 8453, 5);
    const keyOfVault = (n: number) =>
      vaultKey(8453, list.find((v) => v.name === `Vault ${n}`)!.vaultAddress);
    expect(names(visible)).not.toEqual(
      expect.arrayContaining(['Vault 90', 'Vault 91', 'Vault 92']),
    );
    expect(hiddenKeys).toContain(keyOfVault(90));
    expect(hiddenKeys).toContain(keyOfVault(92));
    // The list rounds APY, so a 0.00 vault may still count on the server.
    expect(hiddenKeys).not.toContain(keyOfVault(91));
  });

  it('hides a vault at capacity while enough other vaults are open', () => {
    const list = [vault(99, 9999, { atCapacity: true }), ...vaults];
    const { visible, hiddenKeys } = pickVisibleVaults(list, 8453, 5);
    expect(names(visible)).not.toContain('Vault 99');
    expect(visible).toHaveLength(6);
    expect(hiddenKeys).toContain(vaultKey(8453, list[0].vaultAddress));
  });

  it('shows a vault at capacity when too few other vaults are open', () => {
    const list = [vault(99, 9999, { atCapacity: true }), ...vaults.slice(0, 5)];
    // The server still counts it, but its capacity check never enters it.
    expect(names(pickVisibleVaults(list, 8453, 5).visible).at(-1)).toBe(
      'Vault 99',
    );
  });

  it('ignores vaults on other chains', () => {
    const list = [vault(98, 9999, { chainId: 1 }), ...vaults];
    const { visible, hiddenKeys } = pickVisibleVaults(list, 8453, 5);
    expect(names(visible)).not.toContain('Vault 98');
    expect(hiddenKeys.every((k) => k.startsWith('8453:'))).toBe(true);
  });

  it('shows every vault and hides none when fewer than N exist', () => {
    const { visible, hiddenKeys } = pickVisibleVaults(
      vaults.slice(0, 3),
      8453,
      5,
    );
    expect(visible).toHaveLength(3);
    expect(hiddenKeys).toEqual([]);
  });

  it('skips vaults below the TVL floor', () => {
    const { visible, hiddenKeys } = pickVisibleVaults(vaults, 8453, 5, {
      minTvlUsd: 400,
    });
    // The server never counts a vault under the floor, so hiding it is safe.
    expect(names(visible)).toEqual([
      'Vault 2',
      'Vault 6',
      'Vault 4',
      'Vault 3',
    ]);
    expect(hiddenKeys).toEqual(
      [1, 5, 7].map((n) => vaultKey(8453, vaults[n - 1].vaultAddress)),
    );
  });

  it('skips vaults whose liquidity is under twice the floor, or unknown', () => {
    const list = [
      vault(1, 900, { availableLiquidityUsd: 100 }),
      vault(2, 800, { availableLiquidityUsd: 250 }),
      vault(3, 700, { availableLiquidityUsd: null }),
    ];
    const { visible } = pickVisibleVaults(list, 8453, 5, {
      minLiquidityUsd: 100,
    });
    expect(names(visible)).toEqual(['Vault 2']);
  });

  it('keeps a vault with unknown liquidity when there is no liquidity floor', () => {
    const list = [vault(1, 900, { availableLiquidityUsd: null })];
    expect(pickVisibleVaults(list, 8453, 5).visible).toHaveLength(1);
  });

  it('gives the same visible set again when a strategy resumes', () => {
    const first = pickVisibleVaults(vaults, 8453, 5, { minTvlUsd: 400 });
    expect(names(visibleVaultsOf(vaults, 8453, first.hiddenKeys))).toEqual(
      names(first.visible),
    );
  });

  it('drops vaults the wallet hid, whatever the letter case of the key', () => {
    const left = withoutHiddenVaults(vaults, [
      vaultKey(8453, vaults[1].vaultAddress).toUpperCase(),
    ]);
    expect(left).toHaveLength(vaults.length - 1);
    expect(names(left)).not.toContain('Vault 2');
  });

  it('breaks TVL ties by name so the visible set is stable', () => {
    const a = vault(1, 100, { name: 'B' });
    const b = vault(2, 100, { name: 'A' });
    const c = vault(3, 100, { name: 'C' });
    expect(names(pickVisibleVaults([a, b, c], 8453, 1).visible)).toEqual([
      'A',
      'B',
    ]);
  });
});

describe('rankedVaults', () => {
  // The server can enter smaller vaults, and the screen must show its choice.
  it('keeps the visible vaults the server ranked, largest first', () => {
    const visible = [
      vault(1, 450, { name: 'Spark' }),
      vault(2, 447, { name: 'Steakhouse High Yield' }),
      vault(3, 403, { name: 'Gauntlet Prime' }),
    ];
    const ranked = [visible[2], visible[0]].map((v) =>
      vaultKey(8453, v.vaultAddress).toUpperCase(),
    );
    expect(names(rankedVaults(visible, ranked))).toEqual([
      'Spark',
      'Gauntlet Prime',
    ]);
  });

  it('ignores a ranked vault that is not visible', () => {
    const visible = [vault(1, 450)];
    const ranked = [vaultKey(8453, vault(2, 1).vaultAddress)];
    expect(rankedVaults(visible, ranked)).toEqual([]);
  });
});

describe('repeatedNameDetails', () => {
  // The two real Steakhouse Prime vaults start with 0xbeef; the tail differs.
  it('gives a short address to each vault whose name repeats', () => {
    expect(
      repeatedNameDetails([
        {
          name: 'Steakhouse Prime USDC',
          address: '0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9',
        },
        {
          name: 'Spark USDC Vault',
          address: '0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a',
        },
        {
          name: 'Steakhouse Prime USDC',
          address: '0xbeefe94c8ad530842bfe7d8b397938ffc1cb83b2',
        },
      ]),
    ).toEqual(['0xbeef…73c9', null, '0xbeef…83b2']);
  });

  it('treats names that differ only by case or outer spaces as the same', () => {
    expect(
      repeatedNameDetails([
        {
          name: 'Gauntlet USDC Prime',
          address: '0x1111111111111111111111111111111111111111',
        },
        {
          name: 'gauntlet usdc prime ',
          address: '0x2222222222222222222222222222222222222222',
        },
      ]),
    ).toEqual(['0x1111…1111', '0x2222…2222']);
  });

  it('gives no detail when every name is unique', () => {
    expect(
      repeatedNameDetails([
        { name: 'A', address: '0x1111111111111111111111111111111111111111' },
        { name: 'B', address: '0x2222222222222222222222222222222222222222' },
      ]),
    ).toEqual([null, null]);
  });
});
