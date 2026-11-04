import { beforeEach, describe, expect, it } from 'vitest';

import type { EarnConfirmRequest } from '~/core/earn/flow';

import {
  answerConfirmation,
  assertWalletSelected,
  confirmForWallet,
  requestConfirmation,
} from './confirm';
import { useEarnRunStore } from './run';

const request: EarnConfirmRequest = {
  kind: 'sign_message',
  action: 'strategy.create',
  message: 'hello',
};

beforeEach(() => {
  answerConfirmation(false);
  useEarnRunStore.setState({ confirmation: null, pageOpen: true });
});

describe('requestConfirmation', () => {
  it('shows the request and resolves true only when the user approves', async () => {
    const result = requestConfirmation(request);
    expect(useEarnRunStore.getState().confirmation).toEqual(request);
    answerConfirmation(true);
    await expect(result).resolves.toBe(true);
    expect(useEarnRunStore.getState().confirmation).toBeNull();
  });

  it('resolves false when the user rejects', async () => {
    const result = requestConfirmation(request);
    answerConfirmation(false);
    await expect(result).resolves.toBe(false);
  });

  it('declines an open request when a new one arrives, never approving it', async () => {
    const first = requestConfirmation(request);
    const second = requestConfirmation({ ...request, message: 'second' });
    await expect(first).resolves.toBe(false);
    answerConfirmation(true);
    await expect(second).resolves.toBe(true);
  });

  // The user left the Earn page while the flow was between steps.
  it('declines at once, with no sheet, when the Earn page is not open', async () => {
    useEarnRunStore.setState({ pageOpen: false });
    await expect(requestConfirmation(request)).resolves.toBe(false);
    expect(useEarnRunStore.getState().confirmation).toBeNull();
  });

  it('does nothing when there is no open request', () => {
    expect(() => answerConfirmation(true)).not.toThrow();
  });
});

describe('confirmForWallet', () => {
  const runWallet = '0xAAAA000000000000000000000000000000000001';
  const other = '0xbbbb000000000000000000000000000000000002';

  it('asks the user while the run wallet is selected, in any letter case', async () => {
    const result = confirmForWallet(request, runWallet, () =>
      runWallet.toLowerCase(),
    );
    expect(useEarnRunStore.getState().confirmation).toEqual(request);
    answerConfirmation(true);
    await expect(result).resolves.toBe(true);
  });

  it('declines at once, with no sheet, when another wallet is selected', async () => {
    await expect(
      confirmForWallet(request, runWallet, () => other),
    ).resolves.toBe(false);
    expect(useEarnRunStore.getState().confirmation).toBeNull();
  });

  it('lets a send go ahead only while the run wallet is selected', () => {
    expect(() =>
      assertWalletSelected(runWallet, () => runWallet.toLowerCase()),
    ).not.toThrow();
    expect(() => assertWalletSelected(runWallet, () => other)).toThrow(
      expect.objectContaining({ code: 'wallet_switched' }),
    );
  });

  // The user switched wallets while the sheet was open, then approved.
  it('declines an approval given after a wallet switch', async () => {
    let selected = runWallet;
    const result = confirmForWallet(request, runWallet, () => selected);
    selected = other;
    answerConfirmation(true);
    await expect(result).resolves.toBe(false);
  });
});

describe('the fee picked in a review', () => {
  const fee = {
    chainId: 8453,
    maxFeePerGas: '0x2',
    maxPriorityFeePerGas: '0x1',
  };
  const picked = () => useEarnRunStore.getState().pickedFee;

  it('keeps the approved fee for the sends of that review', async () => {
    const result = requestConfirmation(request);
    answerConfirmation(true, fee);
    await expect(result).resolves.toBe(true);
    expect(picked()).toEqual(fee);
  });

  it('drops it when the next review opens', () => {
    useEarnRunStore.setState({ pickedFee: fee });
    requestConfirmation(request);
    expect(picked()).toBeNull();
  });

  it('drops it on a decline and on an approval without a fee', async () => {
    useEarnRunStore.setState({ pickedFee: fee });
    const declined = requestConfirmation(request);
    useEarnRunStore.setState({ pickedFee: fee });
    answerConfirmation(false);
    await declined;
    expect(picked()).toBeNull();

    const approved = requestConfirmation(request);
    useEarnRunStore.setState({ pickedFee: fee });
    answerConfirmation(true);
    await approved;
    expect(picked()).toBeNull();
  });

  // The user closed the Earn page between two sends of one review. The page
  // cleanup answers with no review open.
  it('keeps it when no review is open to answer', () => {
    useEarnRunStore.setState({ pickedFee: fee });
    answerConfirmation(false);
    expect(picked()).toEqual(fee);
  });

  it('drops it when a job starts or ends', () => {
    useEarnRunStore.setState({ pickedFee: fee });
    useEarnRunStore.getState().setJob('close');
    expect(picked()).toBeNull();
    useEarnRunStore.setState({ pickedFee: fee });
    useEarnRunStore.getState().setJob(null);
    expect(picked()).toBeNull();
  });
});
