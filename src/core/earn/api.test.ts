import { describe, expect, it, vi } from 'vitest';

import { EarnApiError, createEarnApi } from './api';

const env = {
  baseUrl: 'https://example.test/functions/v1/api',
  apiKey: 'pk_test',
  siweDomain: 'example.test',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const setup = (response: Response | Error) => {
  const fetchImpl = vi.fn().mockImplementation(async () => {
    if (response instanceof Error) throw response;
    return response.clone();
  });
  return {
    api: createEarnApi(env, fetchImpl as unknown as typeof fetch),
    fetchImpl,
  };
};

describe('createEarnApi', () => {
  it('lists vaults for a chain with the api key header', async () => {
    const { api, fetchImpl } = setup(jsonResponse({ vaults: [{ name: 'A' }] }));
    const vaults = await api.listVaults(8453);
    expect(vaults).toEqual([{ name: 'A' }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${env.baseUrl}/v1/vaults?chains=8453`);
    expect(init.headers.apikey).toBe('pk_test');
  });

  it('reads the native token price of each chain', async () => {
    const { api, fetchImpl } = setup(
      jsonResponse({ ETH: 3421.07, chains: { '8453': 3421.07 } }),
    );
    expect(await api.getNativePrices()).toEqual({ 8453: 3421.07 });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${env.baseUrl}/v1/prices`);
  });

  it('sends the amount for a top-up and for a partial withdrawal, and nothing otherwise', async () => {
    const { api, fetchImpl } = setup(jsonResponse({ transactions: [] }));
    await api.depositCalldata('s1', { amountUsdc: 50 });
    await api.withdrawCalldata('s1', { amountUsdc: 25 });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({
      amountUsdc: 50,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1].body))).toEqual({
      amountUsdc: 25,
    });
    expect(fetchImpl.mock.calls[0][1].headers['content-type']).toBe(
      'application/json',
    );
  });

  it('asks for the partial withdrawal limits with quote true', async () => {
    const quote = { kind: 'withdraw_quote', maxWithdrawUsdc: 540 };
    const { api, fetchImpl } = setup(jsonResponse(quote));
    expect(await api.getWithdrawQuote('s1')).toEqual(quote);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${env.baseUrl}/v1/strategies/s1/calldata/withdraw`,
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({
      quote: true,
    });
  });

  it('patches a strategy with a signed body and returns the strategy', async () => {
    const { api, fetchImpl } = setup(
      jsonResponse({ strategy: { id: 's1', delta_pct: 4 } }),
    );
    const updated = await api.updateStrategy('s1', {
      delta_pct: 4,
      siwe: { message: 'm', signature: '0x1' },
    });
    expect(updated).toEqual({ id: 's1', delta_pct: 4 });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${env.baseUrl}/v1/strategies/s1`);
    expect(fetchImpl.mock.calls[0][1].method).toBe('PATCH');
  });

  it('reads the newest performance snapshot, or null before the first one', async () => {
    const points = [
      { snapshot_at: 'a', cumulative_yield: 1 },
      { snapshot_at: 'b', cumulative_yield: 2 },
    ];
    const some = setup(jsonResponse({ snapshots: points }));
    expect(await some.api.getLatestPerformance('s1')).toEqual(points[1]);
    expect(some.fetchImpl.mock.calls[0][0]).toBe(
      `${env.baseUrl}/v1/strategies/s1/performance?hours=48`,
    );
    const none = setup(jsonResponse({ snapshots: [] }));
    expect(await none.api.getLatestPerformance('s1')).toBeNull();
  });

  it('reads the performance series for a window', async () => {
    const points = [{ snapshot_at: 'a', cumulative_yield: 1 }];
    const { api, fetchImpl } = setup(jsonResponse({ snapshots: points }));
    expect(await api.getPerformance('s1', 168)).toEqual(points);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${env.baseUrl}/v1/strategies/s1/performance?hours=168`,
    );
  });

  it('gives up on a request that never answers', async () => {
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const api = createEarnApi(env, hanging as unknown as typeof fetch, {
      timeoutMs: 20,
    });
    await expect(api.getPerformance('s1', 24)).rejects.toMatchObject({
      code: 'network_error',
    });
  });

  it('reads the wallet hide list from the prefs endpoint', async () => {
    const prefs = { address: '0xabc', hidden_vault_keys: ['8453:0xa'] };
    const { api, fetchImpl } = setup(jsonResponse(prefs));
    expect(await api.getPrefs('0xAbC')).toEqual(prefs);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${env.baseUrl}/v1/wallets/0xAbC/prefs`,
    );
  });

  it('asks the server ranking for its choice and returns lowercase keys', async () => {
    const { api, fetchImpl } = setup(
      jsonResponse({
        vaults: [
          { chainId: 8453, vaultAddress: '0xBB' },
          { chainId: 8453, vaultAddress: '0xAA' },
        ],
      }),
    );
    const keys = await api.rankVaults({
      chainId: 8453,
      capitalUsdc: 600,
      maxPositions: 2,
      minTvlUsd: 1_000_000,
      minLiquidityUsd: 0,
      apySmoothingMinutes: 360,
      hiddenKeys: ['8453:0xcc', '8453:0xdd'],
      wallet: '0xABC',
    });
    expect(keys).toEqual(['8453:0xbb', '8453:0xaa']);
    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.searchParams.has('minLiquidityMultiplier')).toBe(false);
    expect(url.pathname).toBe(
      `${new URL(env.baseUrl).pathname}/v1/vaults/rankings`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      chains: '8453',
      capital: '600',
      maxPositions: '2',
      minTvl: '1000000',
      minLiquidity: '0',
      apySmoothingMinutes: '360',
      hiddenVaultKeys: '8453:0xcc,8453:0xdd',
      wallet: '0xabc',
    });
  });

  it('sends the liquidity entry multiplier only when it is given', async () => {
    const { api, fetchImpl } = setup(jsonResponse({ vaults: [] }));
    await api.rankVaults({
      chainId: 8453,
      capitalUsdc: 600,
      maxPositions: 2,
      minTvlUsd: 0,
      minLiquidityUsd: 1000,
      minLiquidityMultiplier: 1,
      apySmoothingMinutes: 360,
      hiddenKeys: [],
      wallet: '0xabc',
    });
    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.searchParams.get('minLiquidityMultiplier')).toBe('1');
  });

  it('reads the chain minimums from the config endpoint', async () => {
    const config = {
      chains: [{ chainId: 8453, name: 'Base', minStrategyUsdc: 500 }],
    };
    const { api, fetchImpl } = setup(jsonResponse(config));
    expect(await api.getConfig()).toEqual(config);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${env.baseUrl}/v1/config`);
  });

  it('asks for the APY at the strategy smoothing window when one is given', async () => {
    const { api, fetchImpl } = setup(jsonResponse({ vaults: [] }));
    await api.listVaults(8453, 360);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${env.baseUrl}/v1/vaults?chains=8453&window=360`,
    );
  });

  it('reads approvals for one chain and lists the vault keys', async () => {
    const entry = {
      chainId: 8453,
      spender: '0xs',
      usdc: null,
      vaults: [],
      error: null,
    };
    const { api, fetchImpl } = setup(jsonResponse({ chains: [entry] }));
    const result = await api.getApprovals({
      address: '0xAbC',
      chainId: 8453,
      requiredUsdc: '1000000',
      vaultKeys: ['8453:0xa', '8453:0xb'],
    });
    expect(result).toEqual(entry);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${env.baseUrl}/v1/wallets/0xAbC/approvals?chains=8453&requiredUsdc=1000000&vaults=8453%3A0xa%2C8453%3A0xb`,
    );
  });

  it('throws when the approvals read failed for the chain', async () => {
    const entry = {
      chainId: 8453,
      spender: null,
      usdc: null,
      vaults: [],
      error: 'rpc_error',
    };
    const { api } = setup(jsonResponse({ chains: [entry] }));
    await expect(
      api.getApprovals({
        address: '0xa',
        chainId: 8453,
        requiredUsdc: '1',
        vaultKeys: [],
      }),
    ).rejects.toMatchObject({ code: 'rpc_error' });
  });

  it('posts a signed create body and returns the strategy', async () => {
    const { api, fetchImpl } = setup(
      jsonResponse({ strategy: { id: 's1' } }, 201),
    );
    const strategy = await api.createStrategy({
      name: 'x',
      siwe: { message: 'm', signature: '0x1' },
    });
    expect(strategy).toEqual({ id: 's1' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${env.baseUrl}/v1/strategies`);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    const sent = JSON.parse(String(init.body)) as {
      siwe: { signature: string };
    };
    expect(sent.siwe.signature).toBe('0x1');
  });

  it('posts deposit and withdraw calldata requests with no body', async () => {
    const { api, fetchImpl } = setup(jsonResponse({ transactions: [] }));
    await api.depositCalldata('s1');
    await api.withdrawCalldata('s1');
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${env.baseUrl}/v1/strategies/s1/calldata/deposit`,
    );
    expect(fetchImpl.mock.calls[1][0]).toBe(
      `${env.baseUrl}/v1/strategies/s1/calldata/withdraw`,
    );
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
  });

  it('reads a strategy fresh, and lists strategies by wallet', async () => {
    const { api, fetchImpl } = setup(
      jsonResponse({ strategy: { id: 's1' }, strategies: [] }),
    );
    await api.getStrategy('s1');
    await api.listStrategies('0xAbC');
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${env.baseUrl}/v1/strategies/s1?fresh=1`,
    );
    expect(fetchImpl.mock.calls[1][0]).toBe(
      `${env.baseUrl}/v1/strategies?wallet=0xAbC`,
    );
  });

  it('sends a signed delete', async () => {
    const { api, fetchImpl } = setup(
      jsonResponse({ success: true, action: 'closed' }),
    );
    await api.deleteStrategy('s1', {
      siwe: { message: 'm', signature: '0x1' },
    });
    expect(fetchImpl.mock.calls[0][1].method).toBe('DELETE');
  });

  it('maps an api error body to EarnApiError', async () => {
    const { api } = setup(
      jsonResponse(
        {
          error: {
            code: 'invalid_request',
            message: 'Insufficient USDC balance.',
          },
        },
        400,
      ),
    );
    const error = await api.listVaults(8453).catch((e) => e);
    expect(error).toBeInstanceOf(EarnApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'invalid_request',
      message: 'Insufficient USDC balance.',
    });
  });

  it('maps a non JSON failure to bad_response', async () => {
    const { api } = setup(new Response('<html>oops</html>', { status: 502 }));
    await expect(api.listVaults(8453)).rejects.toMatchObject({
      code: 'bad_response',
      status: 502,
    });
  });

  it('maps a network failure to network_error', async () => {
    const { api } = setup(new TypeError('Failed to fetch'));
    await expect(api.listVaults(8453)).rejects.toMatchObject({
      code: 'network_error',
    });
  });
});
