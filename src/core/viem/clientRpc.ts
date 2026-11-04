import { Chain } from 'viem';

import { earnRpcOverride } from '~/core/earn/rpc';
import { useConnectedToHardhatStore } from '~/core/state';

import { proxyRpcEndpoint } from '../providers/proxy';
import { useNetworkStore } from '../state/networks/networks';
import { ChainId, chainHardhat, chainHardhatOptimism } from '../types/chains';

const IS_TESTING = process.env.IS_TESTING === 'true';

const getOriginalRpcEndpoint = (chain: Chain) => {
  const userAddedChain = useNetworkStore
    .getState()
    .getActiveRpcForChain(chain.id);
  if (userAddedChain) {
    return userAddedChain.rpcUrls.default.http[0];
  }
  return chain.rpcUrls.default.http[0];
};

export const handleRpcUrl = (chain: Chain) => {
  // Earn demo build: Base can use an endpoint that needs no Rainbow key.
  const earnRpc = earnRpcOverride(chain.id, process.env.EARN_BASE_RPC_URL);
  if (earnRpc) return earnRpc;
  if (
    (IS_TESTING &&
      ((chain.id === ChainId.mainnet &&
        useConnectedToHardhatStore.getState().connectedToHardhat) ||
        (chain.id === ChainId.optimism &&
          useConnectedToHardhatStore.getState().connectedToHardhatOp))) ||
    chain.id === chainHardhat.id ||
    chain.id === chainHardhatOptimism.id
  ) {
    return chainHardhat.rpcUrls.default.http[0];
  } else {
    return proxyRpcEndpoint(getOriginalRpcEndpoint(chain), chain.id);
  }
};
