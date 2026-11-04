import type { EarnPickedFee } from '~/core/earn/fees';
import { type EarnConfirmRequest, EarnFlowError } from '~/core/earn/flow';
import { isLowerCaseMatch } from '~/core/utils/strings';

import { useEarnRunStore } from './run';

let resolveOpen: ((approved: boolean) => void) | null = null;

// Opens the confirmation sheet and waits for the user. Resolves true only
// when the user presses the approve button. Everything else is a rejection:
// the reject button, closing the sheet, or a newer request replacing this
// one. If the popup closes first, the promise never resolves and nothing is
// signed. With the Earn page closed there is no sheet to show it, so the
// request is declined at once.
export function requestConfirmation(
  request: EarnConfirmRequest,
): Promise<boolean> {
  answerConfirmation(false);
  if (!useEarnRunStore.getState().pageOpen) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    resolveOpen = resolve;
    useEarnRunStore.getState().setConfirmation(request);
  });
}

// A run signs with the wallet it started with. Its reviews count only while
// that wallet is still the selected one, both when asked and when approved.
export async function confirmForWallet(
  request: EarnConfirmRequest,
  wallet: string,
  selectedWallet: () => string,
): Promise<boolean> {
  if (!isLowerCaseMatch(selectedWallet(), wallet)) return false;
  const approved = await requestConfirmation(request);
  return approved && isLowerCaseMatch(selectedWallet(), wallet);
}

// Called right before each signature and transaction. One approval can cover
// several sends, so a wallet switch between them stops the run.
export function assertWalletSelected(
  wallet: string,
  selectedWallet: () => string,
) {
  if (!isLowerCaseMatch(selectedWallet(), wallet)) {
    throw new EarnFlowError('wallet_switched', 'The selected wallet changed.');
  }
}

// An approval of a transaction review carries the fee the user picked. With
// no review open, the picked fee stays: the sends of the last review can still
// be running after the Earn page closed.
export function answerConfirmation(approved: boolean, fee?: EarnPickedFee) {
  const resolve = resolveOpen;
  resolveOpen = null;
  if (resolve) {
    useEarnRunStore.setState({ pickedFee: (approved && fee) || null });
  }
  useEarnRunStore.getState().setConfirmation(null);
  resolve?.(approved);
}
