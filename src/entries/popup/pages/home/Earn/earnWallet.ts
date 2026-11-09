import { supportsDelegation } from '@rainbow-me/delegation';
import { Address, Hex, toHex } from 'viem';

import { createEarnApi } from '~/core/earn/api';
import { EARN_ENVIRONMENTS } from '~/core/earn/defaults';
import { type FeeFields, pickedFeeFor, sendGasLimit } from '~/core/earn/fees';
import {
  EarnFlowDeps,
  EarnFlowError,
  EarnFlowStep,
  EarnSendRequest,
} from '~/core/earn/flow';
import type { EarnSettings } from '~/core/earn/types';
import { getDelegationAvailable } from '~/core/resources/delegations/featureStatus';
import { useCurrentAddressStore, useGasStore } from '~/core/state';
import { useEarnStore } from '~/core/state/earn';
import {
  assertWalletSelected,
  confirmForWallet,
} from '~/core/state/earn/confirm';
import { useEarnRunStore } from '~/core/state/earn/run';
import { TxHash } from '~/core/types/transactions';
import { estimateGasWithPadding } from '~/core/utils/gas';
import { addNewTransaction } from '~/core/utils/transactions';
import { getProvider } from '~/core/viem/clientToProvider';
import { getViemClient } from '~/core/viem/clients';

import { popupClient } from '../../../handlers/background';
import { personalSign, sendTransaction } from '../../../handlers/wallet';

const APPROVE_SELECTOR = '0x095ea7b3';
const EARN_APP_HOST = 'earn.quicknode.com';
const BATCH_WAIT_MS = 120_000;
// Off for the demo: a batch review has no fee picker.
const BATCH_APPROVALS = false;

// A check that passes here but fails in the background must not trap the user
// in the same failure, so a failed batch turns batching off for this session.
let batchFailedThisSession = false;

export function createEarnDeps({
  address,
  settings,
  onStep,
}: {
  address: Address;
  settings: EarnSettings;
  onStep?: (step: EarnFlowStep) => void;
}): EarnFlowDeps {
  const env = EARN_ENVIRONMENTS[settings.environment];
  // A run signs with the wallet it started with, and only while it is selected.
  const selected = () => useCurrentAddressStore.getState().currentAddress;

  // Rainbow's own padded estimate, the one its send and swap screens use.
  const estimateGas = async ({ chainId, to, data }: EarnSendRequest) => {
    const gas = await estimateGasWithPadding({
      transactionRequest: { from: address, to, data, chainId },
      provider: getProvider({ chainId }),
    });
    return gas ? BigInt(gas) : null;
  };

  const send = async ({
    chainId,
    to,
    data,
    gasLimit: hint,
  }: EarnSendRequest) => {
    const fees: FeeFields<bigint> =
      pickedFeeFor(chainId, useEarnRunStore.getState().pickedFee) ??
      (await getViemClient({ chainId }).estimateFeesPerGas());
    const gasLimit = sendGasLimit(
      await estimateGas({ chainId, to, data }),
      hint,
    );
    if (gasLimit === undefined) {
      throw new EarnFlowError(
        'gas_unknown',
        'The wallet could not estimate the gas of the next transaction. It was not sent.',
      );
    }
    assertWalletSelected(address, selected);
    const result = await sendTransaction(
      {
        from: address,
        to,
        data,
        chainId,
        gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        gasPrice: fees.gasPrice,
      },
      { useCallerGas: true },
    );
    addNewTransaction({
      address,
      chainId,
      transaction: {
        data: result.data,
        value: '0',
        from: address,
        to,
        hash: result.hash as TxHash,
        chainId,
        status: 'pending',
        type: data.startsWith(APPROVE_SELECTOR)
          ? 'approve'
          : 'contract_interaction',
        nonce: result.nonce,
        maxFeePerGas: fees.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas?.toString(),
        gasPrice: fees.gasPrice?.toString(),
      },
    });
    return { hash: result.hash as Hex };
  };

  // Rainbow's Smart Wallet path. It needs the delegation feature, a software
  // wallet, and Rainbow's platform API to confirm the chain.
  const canBatch = async (chainId: number) => {
    if (!BATCH_APPROVALS || batchFailedThisSession) return false;
    if (!getDelegationAvailable(address).available) return false;
    let supported = false;
    try {
      ({ supported } = await supportsDelegation({
        address,
        chainId,
        requireFreshStatus: true,
      }));
    } catch {
      return false;
    }
    if (!supported) return false;
    // An earlier batch can still be pending, also from a popup that closed.
    // A new one would send the same approvals again, so stop before the sheet.
    const client = getViemClient({ chainId });
    const [pending, mined] = await Promise.all([
      client.getTransactionCount({ address, blockTag: 'pending' }),
      client.getTransactionCount({ address, blockTag: 'latest' }),
    ]);
    if (pending > mined) {
      throw new EarnFlowError(
        'batch_pending',
        'An earlier transaction is still pending. Check Activity, then try again.',
      );
    }
    return true;
  };

  const sendBatch = async (txs: EarnSendRequest[]) => {
    const { chainId } = txs[0];
    const fees = await getViemClient({ chainId }).estimateFeesPerGas();
    // The batch reads its fee from the gas store, which Rainbow's own fee
    // picker fills on its screens. A batch review has none, so fill it here.
    const { selectedGas, setSelectedGas } = useGasStore.getState();
    setSelectedGas({
      selectedGas: {
        ...selectedGas,
        transactionGasParams: {
          maxFeePerGas: toHex(fees.maxFeePerGas ?? 0n),
          maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas ?? 0n),
        },
      } as typeof selectedGas,
    });
    let nonces: number[];
    assertWalletSelected(address, selected);
    try {
      ({ nonces } = await popupClient.wallet.executeSendCallsBatch({
        sendParams: {
          version: '2.0.0',
          chainId: toHex(chainId),
          from: address,
          calls: txs.map((tx) => ({ to: tx.to, data: tx.data, value: '0x0' })),
          atomicRequired: true,
        },
        sender: address,
        app: EARN_APP_HOST,
      }));
    } catch (e) {
      batchFailedThisSession = true;
      throw e;
    }
    // The batch returns once sent. Wait until it is mined, so a slow block
    // cannot make a retry send the approvals a second time.
    const client = getViemClient({ chainId });
    const deadline = Date.now() + BATCH_WAIT_MS;
    const sent = Math.max(...nonces);
    while (
      // eslint-disable-next-line no-await-in-loop
      (await client.getTransactionCount({ address, blockTag: 'latest' })) <=
      sent
    ) {
      if (Date.now() > deadline) {
        throw new EarnFlowError(
          'batch_pending',
          'The approval transaction is still pending. Check Activity, then try again.',
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
    }
  };

  const api = createEarnApi(env);

  return {
    api,
    address,
    chainId: settings.chainId,
    siwe: { domain: env.siweDomain, uri: `https://${env.siweDomain}` },
    // Rainbow signs from inside the wallet without a screen of its own, so
    // the confirmation sheet is the only place the user can say no.
    confirm: (request) => confirmForWallet(request, address, selected),
    signMessage: async (message) => {
      assertWalletSelected(address, selected);
      return personalSign({ type: 'personal_sign', message }, address);
    },
    sendTransaction: send,
    estimateGas,
    canBatch,
    sendBatch,
    waitForReceipt: async (hash, chainId) => {
      const receipt = await getViemClient({
        chainId,
      }).waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== 'success') {
        throw new EarnFlowError(
          'tx_reverted',
          'A transaction failed on chain. Check Activity for details.',
        );
      }
    },
    deposits: {
      get: (strategyId) => useEarnStore.getState().sentDeposits[strategyId],
      set: (strategyId, hash) =>
        useEarnStore.getState().setSentDeposit(strategyId, hash),
    },
    onStep,
  };
}
