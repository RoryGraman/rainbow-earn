const BASE_CHAIN_ID = 8453;

// Rainbow's Base RPC proxy needs Rainbow's key, so a demo build can set
// EARN_BASE_RPC_URL. It must be https: webpack.config.js adds its origin to
// the extension CSP.
export function earnRpcOverride(
  chainId: number,
  url: string | undefined,
): string | undefined {
  if (chainId !== BASE_CHAIN_ID || !url) return undefined;
  const trimmed = url.trim();
  try {
    return new URL(trimmed).protocol === 'https:' ? trimmed : undefined;
  } catch {
    return undefined;
  }
}
