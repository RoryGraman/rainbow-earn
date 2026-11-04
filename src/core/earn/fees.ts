export type FeeFields<T> = {
  maxFeePerGas?: T;
  maxPriorityFeePerGas?: T;
  gasPrice?: T;
};

// Picks the fee fields for a transaction.
//
// Default (`useCallerFees` false): the request wins field by field, and the
// fee screen's stored values fill the gaps. This is how Rainbow has always
// worked, so existing callers see no change.
//
// With `useCallerFees` and a caller fee set: only the caller's fields are
// used. A stored gasPrice would break an EIP-1559 transaction, and a stored
// value could belong to another chain. A zero priority fee stays zero.
export function resolveFeeParams<T>(
  request: FeeFields<T>,
  stored: FeeFields<T>,
  useCallerFees: boolean,
): FeeFields<T> {
  const callerSetFees =
    request.maxFeePerGas != null || request.gasPrice != null;
  if (useCallerFees && callerSetFees) {
    return {
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      gasPrice: request.gasPrice,
    };
  }
  return {
    maxFeePerGas: request.maxFeePerGas || stored.maxFeePerGas,
    maxPriorityFeePerGas:
      request.maxPriorityFeePerGas || stored.maxPriorityFeePerGas,
    gasPrice: request.gasPrice || stored.gasPrice,
  };
}

const feeFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

// A fee below one cent reads "< $0.01", never a misleading $0.00.
export const displayFeeUsd = (usd: number) =>
  usd > 0 && usd < 0.005 ? '< $0.01' : feeFormat.format(usd);

// The gas limit a transaction is sent with: Rainbow's padded estimate, never
// below the Earn service's hint. Undefined, never zero, when neither is known.
export function sendGasLimit(
  estimate: bigint | null | undefined,
  hint: bigint | undefined,
): bigint | undefined {
  const limit = (estimate ?? 0n) > (hint ?? 0n) ? estimate ?? 0n : hint ?? 0n;
  return limit > 0n ? limit : undefined;
}

// The fee the user picked in a review, as Rainbow's fee picker gives it: hex
// strings, for one chain.
export type EarnPickedFee = {
  chainId: number;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
};

// The fee fields of a send from the picked fee. Undefined for another chain,
// no pick, or a pick that is not a number, so the caller estimates its own.
export function pickedFeeFor(
  chainId: number,
  picked: EarnPickedFee | null | undefined,
): FeeFields<bigint> | undefined {
  if (!picked || picked.chainId !== chainId) return undefined;
  const big = (hex?: string) => (hex ? BigInt(hex) : undefined);
  try {
    const fee = {
      maxFeePerGas: big(picked.maxFeePerGas),
      maxPriorityFeePerGas: big(picked.maxPriorityFeePerGas),
      gasPrice: big(picked.gasPrice),
    };
    return fee.maxFeePerGas !== undefined || fee.gasPrice !== undefined
      ? fee
      : undefined;
  } catch {
    return undefined;
  }
}

// A stand-in for the wallet's native asset in Rainbow's fee math, when
// Rainbow's asset service has none (a build without Rainbow's keys). The fee
// math reads only the symbol, the decimals and the USD price.
export function nativeAssetForFee(symbol: string, usd: number | undefined) {
  return usd !== undefined && Number.isFinite(usd) && usd > 0
    ? { symbol, decimals: 18, price: { value: usd } }
    : undefined;
}
