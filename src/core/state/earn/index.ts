import { createBaseStore } from '@storesjs/stores';
import type { Hex } from 'viem';

import { DEFAULT_EARN_SETTINGS } from '~/core/earn/defaults';
import type { EarnSettings } from '~/core/earn/types';

import { createExtensionStoreOptions } from '../_internal';

interface EarnState {
  settings: EarnSettings;
  updateSettings: (patch: Partial<EarnSettings>) => void;
  resetSettings: () => void;
  // `pendingKey(environment, wallet)` to the strategy that was created but
  // not yet funded. A production id is never used on staging.
  pendingStrategies: Record<string, string>;
  setPendingStrategy: (key: string, strategyId: string | null) => void;
  // Strategy id to the deposit transaction already sent for it.
  sentDeposits: Record<string, Hex>;
  setSentDeposit: (strategyId: string, hash: Hex | null) => void;
}

export const pendingKey = (environment: string, address: string) =>
  `${environment}:${address.toLowerCase()}`;

const without = <T>(record: Record<string, T>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

export const useEarnStore = createBaseStore<EarnState>(
  (set) => ({
    settings: DEFAULT_EARN_SETTINGS,
    updateSettings: (patch) =>
      set((state) => ({ settings: { ...state.settings, ...patch } })),
    resetSettings: () => set({ settings: DEFAULT_EARN_SETTINGS }),
    pendingStrategies: {},
    setPendingStrategy: (key, strategyId) =>
      set((state) => ({
        pendingStrategies: strategyId
          ? { ...state.pendingStrategies, [key]: strategyId }
          : without(state.pendingStrategies, key),
      })),
    sentDeposits: {},
    setSentDeposit: (strategyId, hash) =>
      set((state) => ({
        sentDeposits: hash
          ? { ...state.sentDeposits, [strategyId]: hash }
          : without(state.sentDeposits, strategyId),
      })),
  }),
  createExtensionStoreOptions({
    storageKey: 'earn',
    version: 0,
  }),
);
