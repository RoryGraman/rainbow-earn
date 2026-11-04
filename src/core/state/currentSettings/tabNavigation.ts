import { createBaseStore } from '@storesjs/stores';

// eslint-disable-next-line boundaries/element-types
import type { Tab } from '~/entries/popup/components/Tabs/TabBar';

import { createExtensionStoreOptions } from '../_internal';

interface TabNavigationState {
  selectedTab: Tab;
  setSelectedTab: (newSelectedTab: Tab) => void;
}

export const useTabNavigation = createBaseStore<TabNavigationState>(
  (set) => ({
    selectedTab: 'tokens',
    setSelectedTab: (newSelectedTab) => set({ selectedTab: newSelectedTab }),
  }),
  createExtensionStoreOptions({
    storageKey: 'tabNavigation',
    version: 2,
    migrate(persistedState, version) {
      if (version === 0) {
        return {}; // Use defaults, points was replaced with rewards
      }
      // An early Earn build had an Earn tab. Earn is a page now.
      if ((persistedState as { selectedTab?: string }).selectedTab === 'earn') {
        return {};
      }
      return persistedState as TabNavigationState;
    },
  }),
);
