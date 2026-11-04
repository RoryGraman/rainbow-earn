const BASE_CHAIN_ID = 8453;

// Rainbow reaches Base through its own RPC proxy, which needs Rainbow's key.
// A demo build can point Base at another endpoint, such as a Quicknode one,
// through EARN_BASE_RPC_URL. Only Base is affected, and only when the URL is
// set. It must be https. webpack.config.js adds its origin to the extension
// CSP at build time, so any https host works.
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
