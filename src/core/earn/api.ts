import type { PerformancePoint } from './strategies';
import type {
  EarnChainApprovals,
  EarnConfig,
  EarnDepositCalldata,
  EarnEnvironment,
  EarnPrefs,
  EarnStrategy,
  EarnVault,
  EarnWithdrawCalldata,
  EarnWithdrawQuote,
} from './types';

export class EarnApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'EarnApiError';
    this.status = status;
    this.code = code;
  }
}

type SignedBody = Record<string, unknown>;

export function createEarnApi(
  env: EarnEnvironment,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  { timeoutMs = 20_000 }: { timeoutMs?: number } = {},
) {
  async function request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const hasBody = init.body !== undefined;
    let response: Response;
    try {
      response = await fetchImpl(`${env.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          apikey: env.apiKey,
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(init.body) : undefined,
        // A stalled read fails, so no screen waits on it forever. Writes keep
        // no timeout: an aborted create could still land on the server.
        signal: hasBody ? undefined : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new EarnApiError(0, 'network_error', (e as Error).message);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new EarnApiError(
        response.status,
        'bad_response',
        'The Earn API sent an unreadable reply.',
      );
    }

    if (!response.ok) {
      const error = (json as { error?: { code?: string; message?: string } })
        ?.error;
      throw new EarnApiError(
        response.status,
        error?.code ?? 'bad_response',
        error?.message ?? `The Earn API request failed (${response.status}).`,
      );
    }
    return json as T;
  }

  async function getApprovals({
    address,
    chainId,
    requiredUsdc,
    vaultKeys,
  }: {
    address: string;
    chainId: number;
    requiredUsdc: string;
    vaultKeys: string[];
  }): Promise<EarnChainApprovals> {
    const vaults = vaultKeys.length
      ? `&vaults=${encodeURIComponent(vaultKeys.join(','))}`
      : '';
    const { chains } = await request<{ chains: EarnChainApprovals[] }>(
      `/v1/wallets/${address}/approvals?chains=${chainId}&requiredUsdc=${requiredUsdc}${vaults}`,
    );
    const entry = chains.find((chain) => chain.chainId === chainId);
    if (!entry) {
      throw new EarnApiError(
        200,
        'bad_response',
        'The Earn API sent no approvals for this chain.',
      );
    }
    if (entry.error) {
      throw new EarnApiError(200, entry.error, 'Could not read approvals.');
    }
    return entry;
  }

  return {
    getConfig() {
      return request<EarnConfig>('/v1/config');
    },

    // Best first. The server's APY has more decimals than the vault list, so
    // only this ranking can break ties.
    async rankVaults({
      chainId,
      capitalUsdc,
      maxPositions,
      minTvlUsd,
      minLiquidityUsd,
      minLiquidityMultiplier,
      apySmoothingMinutes,
      hiddenKeys,
      wallet,
    }: {
      chainId: number;
      capitalUsdc: number;
      maxPositions: number;
      minTvlUsd: number;
      minLiquidityUsd: number;
      // Left out, the server uses 2: the bar for a new strategy.
      minLiquidityMultiplier?: number;
      apySmoothingMinutes: number;
      hiddenKeys: string[];
      wallet: string;
    }): Promise<string[]> {
      const query = new URLSearchParams({
        chains: String(chainId),
        capital: String(capitalUsdc),
        maxPositions: String(maxPositions),
        minTvl: String(minTvlUsd),
        minLiquidity: String(minLiquidityUsd),
        apySmoothingMinutes: String(apySmoothingMinutes),
        hiddenVaultKeys: hiddenKeys.join(','),
        wallet: wallet.toLowerCase(),
      });
      if (minLiquidityMultiplier !== undefined) {
        query.set('minLiquidityMultiplier', String(minLiquidityMultiplier));
      }
      const { vaults } = await request<{
        vaults: { chainId: number; vaultAddress: string }[];
      }>(`/v1/vaults/rankings?${query}`);
      return vaults.map(
        (vault) => `${vault.chainId}:${vault.vaultAddress.toLowerCase()}`,
      );
    },

    // The wallet's global hide list also counts on the server, so the
    // client must leave those vaults out of its pick.
    getPrefs(address: string) {
      return request<EarnPrefs>(`/v1/wallets/${address}/prefs`);
    },

    // `windowMinutes` makes `apy` the figure at the strategy's smoothing window.
    async listVaults(
      chainId: number,
      windowMinutes?: number,
    ): Promise<EarnVault[]> {
      const window = windowMinutes ? `&window=${windowMinutes}` : '';
      const { vaults } = await request<{ vaults: EarnVault[] }>(
        `/v1/vaults?chains=${chainId}${window}`,
      );
      return vaults;
    },

    getApprovals,

    // In USD, keyed by chain id.
    async getNativePrices(): Promise<Record<number, number>> {
      const { chains } = await request<{ chains: Record<string, number> }>(
        '/v1/prices',
      );
      return Object.fromEntries(
        Object.entries(chains ?? {}).map(([id, usd]) => [Number(id), usd]),
      );
    },

    async createStrategy(body: SignedBody): Promise<EarnStrategy> {
      const { strategy } = await request<{ strategy: EarnStrategy }>(
        '/v1/strategies',
        { method: 'POST', body },
      );
      return strategy;
    },

    async getStrategy(id: string): Promise<EarnStrategy> {
      const { strategy } = await request<{ strategy: EarnStrategy }>(
        `/v1/strategies/${id}?fresh=1`,
      );
      return strategy;
    },

    listStrategies(wallet: string) {
      return request<{
        strategies: EarnStrategy[];
        closedStrategies: EarnStrategy[];
      }>(`/v1/strategies?wallet=${wallet}`);
    },

    // With `amountUsdc`, a top-up of an open strategy.
    depositCalldata(id: string, body?: { amountUsdc: number }) {
      return request<EarnDepositCalldata>(
        `/v1/strategies/${id}/calldata/deposit`,
        { method: 'POST', body },
      );
    },

    // With `amountUsdc`, a partial withdrawal.
    withdrawCalldata(id: string, body?: { amountUsdc: number }) {
      return request<EarnWithdrawCalldata>(
        `/v1/strategies/${id}/calldata/withdraw`,
        { method: 'POST', body },
      );
    },

    // Writes nothing, despite the POST.
    getWithdrawQuote(id: string) {
      return request<EarnWithdrawQuote>(
        `/v1/strategies/${id}/calldata/withdraw`,
        { method: 'POST', body: { quote: true } },
      );
    },

    async getLatestPerformance(id: string): Promise<PerformancePoint | null> {
      const { snapshots } = await request<{ snapshots: PerformancePoint[] }>(
        `/v1/strategies/${id}/performance?hours=48`,
      );
      return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
    },

    // Oldest first.
    async getPerformance(
      id: string,
      hours: number,
    ): Promise<PerformancePoint[]> {
      const { snapshots } = await request<{ snapshots: PerformancePoint[] }>(
        `/v1/strategies/${id}/performance?hours=${hours}`,
      );
      return snapshots;
    },

    async updateStrategy(id: string, body: SignedBody): Promise<EarnStrategy> {
      const { strategy } = await request<{ strategy: EarnStrategy }>(
        `/v1/strategies/${id}`,
        { method: 'PATCH', body },
      );
      return strategy;
    },

    deleteStrategy(id: string, body: SignedBody) {
      return request<{ success: boolean; action: string }>(
        `/v1/strategies/${id}`,
        { method: 'DELETE', body },
      );
    },
  };
}

export type EarnApi = ReturnType<typeof createEarnApi>;
