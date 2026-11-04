import { encodeFunctionData, erc20Abi } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SELF_BATCH_DEPOSIT_ABI } from './abi';
import { type EarnApi, EarnApiError } from './api';
import { DEFAULT_EARN_SETTINGS } from './defaults';
import {
  EarnConfirmRequest,
  EarnFlowDeps,
  EarnFlowError,
  EarnFlowStep,
  EarnSendRequest,
  partialWithdraw,
  startStrategy,
  topUpStrategy,
  updateStrategySettings,
  withdrawStrategy,
} from './flow';
import type { EarnVault } from './types';
import { vaultKey } from './vaults';

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678' as const;
const PROXY = '0x0ea9000000000000000000000000000000000c00';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const addr = (n: number) => `0x${n.toString(16).padStart(40, 'a')}`;
// TVL is in millions, so the vaults clear the default $1M TVL floor.
const vault = (n: number, tvlMillions: number): EarnVault => ({
  chainId: 8453,
  vaultAddress: addr(n),
  name: `Vault ${n}`,
  apy: 5,
  tvlUsd: tvlMillions * 1_000_000,
  availableLiquidityUsd: tvlMillions * 1_000_000,
  maxDepositUsd: null,
  atCapacity: false,
});
// Vault 7 is the extra visible vault the server needs. Vault 1 has the
// lowest TVL, so it is hidden.
const VAULTS = [
  vault(1, 100),
  vault(2, 900),
  vault(3, 500),
  vault(4, 700),
  vault(5, 300),
  vault(6, 800),
  vault(7, 200),
];
const SELECTED = [2, 6, 4, 3, 5].map(addr);
// The vaults a create review lists, largest first.
const summaryVaults = (addresses: string[]) =>
  addresses.map((address) => ({
    address,
    name: VAULTS.find((v) => v.vaultAddress === address)?.name,
    apy: 5,
  }));
const HIDDEN = [1].map((n) => vaultKey(8453, addr(n)));

const MAX_UINT256 = (2n ** 256n - 1n).toString();

const approveData = (spender: string, amount: bigint) =>
  encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender as `0x${string}`, amount],
  });

// USDC needs the deposit amount (100 USDC). Share tokens need the maximum.
const approvalEntry = (token: string, approved: boolean) => ({
  token,
  currentAllowance: '0',
  requiredAllowance: token === USDC ? '100000000' : MAX_UINT256,
  approved,
  ...(approved
    ? {}
    : {
        tx: {
          to: token,
          data: approveData(
            PROXY,
            BigInt(token === USDC ? '100000000' : MAX_UINT256),
          ),
          value: '0',
        },
      }),
});

const chainApprovals = (unapprovedVaults: number[]) => ({
  chainId: 8453,
  spender: PROXY,
  error: null,
  usdc: approvalEntry(USDC, false),
  vaults: SELECTED.map((a, i) =>
    approvalEntry(a, !unapprovedVaults.includes(i)),
  ),
});

type Plan = { vaults: string[]; amounts: string[]; totalUsdc: string };

// The server's split: the amount over the vaults, the remainder in the last.
const planFor = (vaults: string[], totalUsdc = 100): Plan => {
  const total = BigInt(Math.round(totalUsdc * 1e6));
  const each = total / BigInt(vaults.length);
  return {
    vaults,
    amounts: vaults.map((_, i) =>
      (i === vaults.length - 1
        ? total - each * BigInt(vaults.length - 1)
        : each
      ).toString(),
    ),
    totalUsdc: total.toString(),
  };
};

const BURN = {
  destDomain: 6,
  mintRecipient: `0x${'0'.repeat(24)}${ADDRESS.slice(2)}` as `0x${string}`,
  destinationCaller: `0x${'0'.repeat(64)}` as `0x${string}`,
  amount: 1n,
  maxFee: 0n,
  minFinalityThreshold: 0,
};

const depositData = (
  { vaults, amounts }: Pick<Plan, 'vaults' | 'amounts'>,
  burns: (typeof BURN)[] = [],
) =>
  encodeFunctionData({
    abi: SELF_BATCH_DEPOSIT_ABI,
    functionName: 'selfBatchDeposit',
    args: [vaults as `0x${string}`[], amounts.map(BigInt), burns],
  });

// The transaction data always encodes the plan, as the server builds it.
const depositCalldata = (overrides: Record<string, unknown> = {}) => {
  const plan = (overrides.plan as Plan | undefined) ?? planFor(SELECTED);
  return {
    transactions: [
      {
        chainId: 8453,
        to: PROXY,
        data: depositData(plan),
        value: '0',
        gasHint: '231000',
        intentId: 'i1',
      },
    ],
    approvalsNeeded: [],
    plan,
    expiresAt: '2026-10-29T13:00:00.000Z',
    ...overrides,
  };
};

const strategy = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 's1',
  wallet_address: ADDRESS,
  name: 'Rainbow Earn',
  capital_usdc: 100,
  status,
  chain_id: 8453,
  hidden_vault_keys: HIDDEN,
  max_positions: 5,
  ...extra,
});

const allApproved = () => ({
  ...chainApprovals([]),
  usdc: approvalEntry(USDC, true),
});

function memoryDeposits(initial: Record<string, `0x${string}`> = {}) {
  const store = { ...initial };
  return {
    get: vi.fn((id: string) => store[id]),
    set: vi.fn((id: string, hash: `0x${string}` | null) => {
      if (hash) store[id] = hash;
      else delete store[id];
    }),
  };
}

function makeDeps(
  overrides: Partial<Record<keyof EarnApi, unknown>> = {},
  // Kinds of confirmation the simulated user declines.
  opts: { decline?: string[] } = {},
) {
  const calls: string[] = [];
  // Approvals asked, signatures made, and transactions sent, in one order.
  const trace: string[] = [];
  const confirms: EarnConfirmRequest[] = [];
  const steps: EarnFlowStep[] = [];
  const sent: Array<{
    to: string;
    data: string;
    chainId: number;
    gasLimit?: bigint;
  }> = [];
  const track = <T>(name: string, value: T) =>
    vi.fn(async () => {
      calls.push(name);
      return value;
    });

  const api = {
    listVaults: track('listVaults', VAULTS),
    // First read: three tokens missing. Later reads: all approved on chain.
    getApprovals: (() => {
      let reads = 0;
      return vi.fn(async () => {
        calls.push('getApprovals');
        reads += 1;
        return reads === 1 ? chainApprovals([0, 1]) : allApproved();
      });
    })(),
    createStrategy: track('createStrategy', strategy('pending_setup')),
    depositCalldata: track('depositCalldata', depositCalldata()),
    withdrawCalldata: track('withdrawCalldata', {
      transactions: [
        {
          chainId: 8453,
          to: PROXY,
          data: '0xc105e',
          value: '0',
          gasHint: '310000',
        },
      ],
      approvalsNeeded: [],
    }),
    getPrefs: vi.fn(async () => ({ hidden_vault_keys: [] as string[] })),
    // The server's ranking. Here: the largest vaults left visible.
    rankVaults: vi.fn(
      async ({
        hiddenKeys,
        maxPositions,
      }: {
        hiddenKeys: string[];
        maxPositions: number;
      }) => {
        const hidden = new Set(hiddenKeys.map((k) => k.toLowerCase()));
        return [...VAULTS]
          .sort((a, b) => b.tvlUsd - a.tvlUsd)
          .map((v) => vaultKey(8453, v.vaultAddress))
          .filter((k) => !hidden.has(k))
          .slice(0, maxPositions);
      },
    ),
    // A low minimum keeps the 100 USDC test amounts valid.
    getConfig: vi.fn(async () => ({
      chains: [{ chainId: 8453, name: 'Base', minStrategyUsdc: 10 }],
    })),
    getStrategy: track('getStrategy', strategy('active')),
    listStrategies: track('listStrategies', []),
    deleteStrategy: track('deleteStrategy', {
      success: true,
      action: 'closed',
    }),
    ...overrides,
  } as unknown as EarnApi;

  const deps: EarnFlowDeps = {
    api,
    address: ADDRESS,
    chainId: 8453,
    siwe: {
      domain: 'earn-api.quicknode.dev',
      uri: 'https://earn-api.quicknode.dev',
    },
    confirm: vi.fn(async (request: EarnConfirmRequest) => {
      confirms.push(request);
      trace.push(`confirm:${request.kind}`);
      return !opts.decline?.includes(request.kind);
    }),
    signMessage: vi.fn(async () => {
      calls.push('sign');
      trace.push('sign');
      return '0xsig' as const;
    }),
    sendTransaction: vi.fn(async (tx) => {
      calls.push(`send:${tx.to}`);
      trace.push(`send:${tx.to}`);
      sent.push(tx);
      return { hash: `0xhash${sent.length}` as const };
    }),
    waitForReceipt: vi.fn(async () => {
      calls.push('wait');
    }),
    onStep: (step) => steps.push(step),
    sleep: vi.fn().mockResolvedValue(undefined),
    pollAttempts: 5,
  };
  return { deps, api, calls, trace, confirms, steps, sent };
}

describe('approval calldata checks', () => {
  const OTHER = '0x9999999999999999999999999999999999999999';
  const usdcWith = (tx: { to: string; data: string }) =>
    vi.fn(async () => ({
      ...chainApprovals([0]),
      usdc: { ...approvalEntry(USDC, false), tx: { ...tx, value: '0' } },
    }));
  const run = (deps: EarnFlowDeps) =>
    startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps);

  it.each([
    ['names another spender', { to: USDC, data: approveData(OTHER, 1n) }],
    ['is not an approve call', { to: USDC, data: '0xdeadbeef' }],
    ['goes to another token', { to: OTHER, data: approveData(PROXY, 1n) }],
  ])(
    'refuses an approval whose calldata %s, before the sheet',
    async (_, tx) => {
      const { deps, confirms, calls } = makeDeps({
        getApprovals: usdcWith(tx),
      });
      await expect(run(deps)).rejects.toMatchObject({
        code: 'approval_mismatch',
      });
      expect(confirms.some((c) => c.kind === 'approvals')).toBe(false);
      expect(calls.filter((c) => c.startsWith('send:'))).toEqual([]);
    },
  );

  it('shows the amount the calldata approves, not the declared one', async () => {
    const { deps, confirms } = makeDeps({
      getApprovals: usdcWith({
        to: USDC,
        data: approveData(PROXY, 250000000n),
      }),
    });
    await run(deps).catch(() => undefined);
    const gate = confirms.find((c) => c.kind === 'approvals');
    expect(gate?.kind === 'approvals' && gate.items[0]).toMatchObject({
      kind: 'usdc',
      amountUsdc: 250,
    });
  });

  it('shows the amount and the vaults with the create signature', async () => {
    const { deps, confirms } = makeDeps();
    await run(deps);
    expect(confirms.find((c) => c.kind === 'sign_message')).toMatchObject({
      action: 'strategy.create',
      summary: { capitalUsdc: 100, vaults: summaryVaults(SELECTED) },
    });
  });
});

describe('startStrategy with a Smart Wallet batch', () => {
  const withBatch = (available: boolean, fail = false) => {
    const made = makeDeps();
    const batches: string[][] = [];
    made.deps.canBatch = vi.fn(async () => available);
    made.deps.sendBatch = vi.fn(async (txs: EarnSendRequest[]) => {
      made.calls.push('batch');
      batches.push(txs.map((tx) => tx.to));
      if (fail) throw new Error('execution reverted');
    });
    return { ...made, batches };
  };

  it('sends every approval in one batch after one approval screen', async () => {
    const { deps, calls, confirms, batches, steps } = withBatch(true);
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    expect(steps.filter((s) => s.kind === 'approving')).toMatchObject([
      {
        index: 1,
        total: 1,
        purpose: 'deposit',
        items: [
          { token: USDC },
          { token: SELECTED[0] },
          { token: SELECTED[1] },
        ],
      },
    ]);
    const approvals = confirms.filter((c) => c.kind === 'approvals');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ batched: true });
    expect(batches).toEqual([[USDC, SELECTED[0], SELECTED[1]]]);
    expect(calls).not.toContain(`send:${USDC}`);
    expect(calls).not.toContain(`send:${SELECTED[0]}`);
    const batchAt = calls.indexOf('batch');
    expect(calls.slice(batchAt)).toEqual([
      'batch',
      'getApprovals',
      'depositCalldata',
      `send:${PROXY}`,
      'wait',
      'getStrategy',
    ]);
  });

  it('sends nothing when the user declines the batch', async () => {
    const { deps, calls, batches } = withBatch(true);
    deps.confirm = vi.fn(
      async (request: EarnConfirmRequest) => request.kind !== 'approvals',
    );
    await expect(
      startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps),
    ).rejects.toMatchObject({ code: 'user_declined' });
    expect(batches).toEqual([]);
    expect(calls.filter((c) => c.startsWith('send:'))).toEqual([]);
  });

  it('stops when the batch fails and never falls back to single sends', async () => {
    const { deps, calls } = withBatch(true, true);
    await expect(
      startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps),
    ).rejects.toMatchObject({ code: 'batch_failed' });
    expect(calls.filter((c) => c.startsWith('send:'))).toEqual([]);
  });

  it('reports a batch that is still pending, so the user does not send it again', async () => {
    const { deps, calls } = withBatch(true);
    deps.sendBatch = vi.fn(async () => {
      throw new EarnFlowError('batch_pending', 'still pending');
    });
    await expect(
      startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps),
    ).rejects.toMatchObject({ code: 'batch_pending' });
    expect(calls.filter((c) => c.startsWith('send:'))).toEqual([]);
  });

  it('sends one transaction per approval when no batch is possible', async () => {
    const { deps, calls, confirms, batches } = withBatch(false);
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    expect(confirms.find((c) => c.kind === 'approvals')).toMatchObject({
      batched: false,
    });
    expect(batches).toEqual([]);
    expect(calls).toContain(`send:${USDC}`);
    expect(calls).toContain(`send:${SELECTED[1]}`);
  });
});

describe('startStrategy', () => {
  it('shows confirming as soon as the deposit is sent, before its receipt', async () => {
    const { deps, steps } = makeDeps();
    const stepAtWait: string[] = [];
    const wait = deps.waitForReceipt;
    deps.waitForReceipt = vi.fn(async (hash, chainId) => {
      stepAtWait.push(steps.at(-1)?.kind ?? '');
      return wait(hash, chainId);
    });
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    expect(stepAtWait.at(-1)).toBe('confirming');
    expect(steps.filter((s) => s.kind === 'confirming')).toHaveLength(1);
  });

  it('signs, creates, approves each missing token, deposits, then waits for active', async () => {
    const { deps, calls, steps, sent } = makeDeps();
    const result = await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );

    expect(calls).toEqual([
      'listVaults',
      'sign',
      'createStrategy',
      'getApprovals',
      `send:${USDC}`,
      'wait',
      `send:${SELECTED[0]}`,
      'wait',
      `send:${SELECTED[1]}`,
      'wait',
      'getApprovals',
      'depositCalldata',
      `send:${PROXY}`,
      'wait',
      'getStrategy',
    ]);
    expect(steps.map((s) => s.kind)).toEqual([
      'selecting',
      'signing',
      'creating',
      'approving',
      'approving',
      'approving',
      'depositing',
      'confirming',
      'active',
    ]);
    // Each approval step names the one token it approves, for its countdown.
    expect(
      steps.flatMap((s) =>
        s.kind === 'approving'
          ? [[s.index, s.total, s.purpose, s.items.map((i) => i.token)]]
          : [],
      ),
    ).toEqual([
      [1, 3, 'deposit', [USDC]],
      [2, 3, 'deposit', [SELECTED[0]]],
      [3, 3, 'deposit', [SELECTED[1]]],
    ]);
    expect(sent.at(-1)).toMatchObject({
      to: PROXY,
      data: depositData(planFor(SELECTED)),
      gasLimit: 231000n,
    });
    expect(sent[0].gasLimit).toBeUndefined();
    expect(result.strategy.status).toBe('active');
    expect(result.vaultsUsed).toBe(5);
  });

  it('opens the deposit review while the last approval is still the step', async () => {
    const { deps, steps } = makeDeps();
    const seen: string[] = [];
    const { confirm } = deps;
    deps.confirm = async (request: EarnConfirmRequest) => {
      seen.push(`${request.kind}@${steps.at(-1)?.kind}`);
      return confirm(request);
    };
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    expect(seen).toContain('deposit@approving');
  });

  it('signs a strategy.create proof and hides every vault outside the six largest', async () => {
    const { deps, api } = makeDeps();
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );

    const message = (deps.signMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(message).toContain(
      'earn-api.quicknode.dev wants you to sign in with your Ethereum account:',
    );
    expect(message).toContain('Authorize strategy.create');
    expect(message).toContain('- path:/strategies');

    const body = (api.createStrategy as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(body).toMatchObject({
      capital_usdc: 100,
      max_positions: 5,
      chain_id: 8453,
      chain_ids: [8453],
      hidden_vault_keys: HIDDEN,
      min_tvl_usd: DEFAULT_EARN_SETTINGS.minTvlUsd,
      min_liquidity_usd: 0,
      siwe: { message, signature: '0xsig' },
    });
    expect(body.name).toMatch(/^[a-zA-Z0-9 _\-.]{1,50}$/);
    expect(typeof body.idempotencyKey).toBe('string');
  });

  it('applies the strategy TVL floor before it takes the top 5', async () => {
    const { deps, api } = makeDeps({
      depositCalldata: vi.fn(async () =>
        depositCalldata({
          plan: planFor(SELECTED.slice(0, 4)),
        }),
      ),
    });
    await startStrategy(
      {
        amountUsdc: 100,
        settings: { ...DEFAULT_EARN_SETTINGS, minTvlUsd: 500_000_000 },
      },
      deps,
    );
    const body = (api.createStrategy as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    // Vaults 1, 5 and 7 fail the floor. The server never counted them, so
    // hiding them is allowed. Fewer than N + 1 vaults pass, so none of the
    // passing ones is hidden.
    expect(body.hidden_vault_keys).toEqual(
      [1, 5, 7].map((n) => vaultKey(8453, addr(n))),
    );
    expect(body.min_tvl_usd).toBe(500_000_000);
    expect(
      (api.getApprovals as ReturnType<typeof vi.fn>).mock.calls[0][0].vaultKeys,
    ).toEqual(SELECTED.slice(0, 4).map((a) => vaultKey(8453, a)));
  });

  // The video case of 2026-10-31: the server enters the visible vaults by its
  // own APY rank, so the largest are not always the ones it uses.
  it('approves the vaults the server ranks first, not the largest', async () => {
    const rankVaults = vi.fn(async () =>
      [7, 2, 4, 3, 5].map((n) => vaultKey(8453, addr(n))),
    );
    const { deps, api } = makeDeps({ rankVaults });
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    expect(rankVaults).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 8453,
        capitalUsdc: 100,
        maxPositions: 5,
        hiddenKeys: HIDDEN,
        minTvlUsd: DEFAULT_EARN_SETTINGS.minTvlUsd,
        minLiquidityUsd: 0,
        apySmoothingMinutes: DEFAULT_EARN_SETTINGS.apySmoothingMinutes,
      }),
    );
    // A new strategy keeps the server's default liquidity entry bar.
    expect(rankVaults.mock.calls[0]).toEqual([
      expect.not.objectContaining({
        minLiquidityMultiplier: expect.anything(),
      }),
    ]);
    expect(
      (api.getApprovals as ReturnType<typeof vi.fn>).mock.calls[0][0].vaultKeys,
    ).toEqual([2, 4, 3, 5, 7].map((n) => vaultKey(8453, addr(n))));
  });

  it('stops before signing when the server ranking cannot be read', async () => {
    const { deps, api } = makeDeps({
      rankVaults: vi.fn(async () => {
        throw new Error('down');
      }),
    });
    await expect(
      startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps),
    ).rejects.toThrow('down');
    expect(deps.signMessage).not.toHaveBeenCalled();
    expect(api.createStrategy).not.toHaveBeenCalled();
  });

  it('ranks a resumed strategy with its own settings', async () => {
    const rankVaults = vi.fn(async () => [vaultKey(8453, addr(2))]);
    const { deps, api } = makeDeps({
      rankVaults,
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(
          strategy('pending_setup', {
            min_tvl_usd: 7,
            min_liquidity_usd: 3,
            min_liquidity_entry_multiplier: 1,
            apy_smoothing_minutes: 60,
          }),
        )
        .mockResolvedValue(strategy('active')),
    });
    await startStrategy(
      {
        amountUsdc: 100,
        settings: DEFAULT_EARN_SETTINGS,
        resumeStrategyId: 's1',
      },
      deps,
    );
    expect(rankVaults).toHaveBeenCalledWith(
      expect.objectContaining({
        capitalUsdc: 100,
        maxPositions: 5,
        hiddenKeys: HIDDEN,
        minTvlUsd: 7,
        minLiquidityUsd: 3,
        minLiquidityMultiplier: 1,
        apySmoothingMinutes: 60,
      }),
    );
    expect(
      (api.getApprovals as ReturnType<typeof vi.fn>).mock.calls[0][0].vaultKeys,
    ).toEqual([vaultKey(8453, addr(2))]);
  });

  it('stops a resume before any approval when the server ranks no vault', async () => {
    const { deps, api } = makeDeps({
      rankVaults: vi.fn(async () => []),
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(strategy('pending_setup'))
        .mockResolvedValue(strategy('active')),
    });
    await expect(
      startStrategy(
        {
          amountUsdc: 100,
          settings: DEFAULT_EARN_SETTINGS,
          resumeStrategyId: 's1',
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'no_vaults' });
    expect(api.getApprovals).not.toHaveBeenCalled();
    expect(api.depositCalldata).not.toHaveBeenCalled();
  });

  it('leaves out vaults the wallet hid on its global list', async () => {
    const { deps, api } = makeDeps({
      getPrefs: vi.fn(async () => ({
        hidden_vault_keys: [vaultKey(8453, addr(2)).toUpperCase()],
      })),
      depositCalldata: vi.fn(async () =>
        depositCalldata({
          plan: planFor([addr(6)]),
        }),
      ),
    });
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    const approvalKeys = (api.getApprovals as ReturnType<typeof vi.fn>).mock
      .calls[0][0].vaultKeys;
    expect(approvalKeys).not.toContain(vaultKey(8453, addr(2)));
    expect(approvalKeys).toHaveLength(5);
    const body = (api.createStrategy as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    // Vault 2 is hidden by the wallet, so the visible set is the six next
    // largest. Nothing else needs hiding.
    expect(body.hidden_vault_keys).toEqual([]);
  });

  it('applies the wallet global hide list when it resumes a strategy', async () => {
    const { deps, api } = makeDeps({
      getPrefs: vi.fn(async () => ({
        hidden_vault_keys: [vaultKey(8453, addr(2))],
      })),
      // Vault 2 is globally hidden, so a plan that uses it must be refused.
      depositCalldata: vi.fn(async () =>
        depositCalldata({
          plan: planFor([addr(6)]),
        }),
      ),
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(strategy('pending_setup'))
        .mockResolvedValue(strategy('active')),
    });
    await startStrategy(
      {
        amountUsdc: 100,
        settings: DEFAULT_EARN_SETTINGS,
        resumeStrategyId: 's1',
      },
      deps,
    );
    const approvalKeys = (api.getApprovals as ReturnType<typeof vi.fn>).mock
      .calls[0][0].vaultKeys;
    expect(approvalKeys).not.toContain(vaultKey(8453, addr(2)));
  });

  it('stops before signing when the amount is below the chain minimum', async () => {
    const { deps, api } = makeDeps({
      getConfig: vi.fn(async () => ({
        chains: [{ chainId: 8453, name: 'Base', minStrategyUsdc: 500 }],
      })),
    });
    await expect(
      startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps),
    ).rejects.toMatchObject({ code: 'below_minimum' });
    expect(deps.signMessage).not.toHaveBeenCalled();
    expect(api.createStrategy).not.toHaveBeenCalled();
  });

  it('stops before signing when no vault passes the floors', async () => {
    const { deps } = makeDeps();
    await expect(
      startStrategy(
        {
          amountUsdc: 100,
          settings: { ...DEFAULT_EARN_SETTINGS, minTvlUsd: 5_000_000_000 },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'no_vaults' });
    expect(deps.signMessage).not.toHaveBeenCalled();
  });

  it('asks the approvals endpoint for the exact amount and selected vaults', async () => {
    const { deps, api } = makeDeps({
      depositCalldata: vi.fn(async () =>
        depositCalldata({ plan: planFor(SELECTED, 12.5) }),
      ),
    });
    await startStrategy(
      { amountUsdc: 12.5, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    expect(
      (api.getApprovals as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toEqual({
      address: ADDRESS,
      chainId: 8453,
      requiredUsdc: '12500000',
      vaultKeys: SELECTED.map((a) => vaultKey(8453, a)),
    });
  });

  it('skips the approvals step when everything is approved', async () => {
    const approved = {
      ...chainApprovals([]),
      usdc: approvalEntry(USDC, true),
    };
    const { deps, calls, steps } = makeDeps({
      getApprovals: vi.fn(async () => approved),
    });
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    expect(calls.filter((c) => c.startsWith('send:'))).toEqual([
      `send:${PROXY}`,
    ]);
    expect(steps.some((s) => s.kind === 'approving')).toBe(false);
  });

  it('does not create a strategy when the user rejects the signature', async () => {
    const { deps, api } = makeDeps();
    deps.signMessage = vi.fn(async () => {
      throw new Error('User rejected');
    });
    await expect(
      startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps),
    ).rejects.toThrow('User rejected');
    expect(api.createStrategy).not.toHaveBeenCalled();
  });

  it('reports the new strategy id before approvals so a retry can resume', async () => {
    const { deps } = makeDeps();
    const onStrategyCreated = vi.fn();
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS, onStrategyCreated },
      deps,
    );
    expect(onStrategyCreated).toHaveBeenCalledWith('s1');
  });

  it('refuses to deposit when approvals are still needed', async () => {
    const { deps, sent } = makeDeps({
      depositCalldata: vi.fn(async () =>
        depositCalldata({
          approvalsNeeded: [
            {
              chainId: 8453,
              token: USDC,
              spender: PROXY,
              currentAllowance: '0',
              requiredAllowance: '1',
              tx: { to: USDC, data: approveData(PROXY, 1n), value: '0' },
            },
          ],
        }),
      ),
    });
    await expect(
      startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps),
    ).rejects.toMatchObject({ code: 'approvals_incomplete' });
    expect(sent.some((tx) => tx.to === PROXY)).toBe(false);
  });

  it('refuses to deposit when the plan uses a vault we did not choose', async () => {
    const { deps, sent } = makeDeps({
      depositCalldata: vi.fn(async () =>
        depositCalldata({
          plan: planFor([addr(1)]),
        }),
      ),
    });
    await expect(
      startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps),
    ).rejects.toMatchObject({ code: 'plan_mismatch' });
    expect(sent.some((tx) => tx.to === PROXY)).toBe(false);
  });

  it('accepts a plan that uses the extra visible vault', async () => {
    const { deps, sent } = makeDeps({
      depositCalldata: vi.fn(async () =>
        depositCalldata({
          plan: planFor([addr(2), addr(7)]),
        }),
      ),
    });
    const result = await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    expect(sent.some((tx) => tx.to === PROXY)).toBe(true);
    expect(result.vaultsUsed).toBe(2);
  });

  it('reads vault APY at the strategy smoothing window', async () => {
    const { deps, api } = makeDeps();
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    expect(api.listVaults).toHaveBeenCalledWith(
      8453,
      DEFAULT_EARN_SETTINGS.apySmoothingMinutes,
    );
  });

  it('waits until the approvals show on chain before it asks for calldata', async () => {
    const getApprovals = vi
      .fn()
      .mockResolvedValueOnce(chainApprovals([0, 1]))
      .mockResolvedValueOnce(chainApprovals([0, 1]))
      .mockResolvedValue(allApproved());
    const { deps, calls } = makeDeps({ getApprovals });
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    expect(getApprovals).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenCalled();
    expect(calls.indexOf('depositCalldata')).toBeGreaterThan(-1);
  });

  it('stops before the deposit when the approvals never show on chain', async () => {
    const getApprovals = vi.fn(async () => chainApprovals([0, 1]));
    const { deps, calls, sent } = makeDeps({ getApprovals });
    deps.approvalAttempts = 3;
    await expect(
      startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps),
    ).rejects.toMatchObject({ code: 'approvals_incomplete' });
    expect(calls).not.toContain('depositCalldata');
    expect(sent.some((tx) => tx.to === PROXY)).toBe(false);
  });

  it('stops before the deposit while one requested share approval is missing', async () => {
    // The server names each vault entry by the vault it was asked about. Its
    // share token can be a different address.
    const withVaultAddress = (
      read: ReturnType<typeof chainApprovals>,
      tokenOf = (vault: string) => vault,
    ) => ({
      ...read,
      vaults: read.vaults.map((entry) => ({
        ...entry,
        vaultAddress: entry.token,
        token: tokenOf(entry.token),
      })),
    });
    const getApprovals = vi
      .fn()
      .mockResolvedValueOnce(withVaultAddress(chainApprovals([0, 1])))
      .mockResolvedValue({
        ...withVaultAddress(chainApprovals([0]), (vault) =>
          vault === SELECTED[0] ? addr(90) : vault,
        ),
        usdc: approvalEntry(USDC, true),
      });
    const { deps, calls, sent } = makeDeps({ getApprovals });
    deps.approvalAttempts = 3;
    await expect(
      startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps),
    ).rejects.toMatchObject({ code: 'approvals_incomplete' });
    expect(calls).not.toContain('depositCalldata');
    expect(sent.some((tx) => tx.to === PROXY)).toBe(false);
  });

  it('refuses to deposit when the plan is empty', async () => {
    const { deps } = makeDeps({
      depositCalldata: vi.fn(async () =>
        depositCalldata({ plan: { vaults: [], amounts: [], totalUsdc: '0' } }),
      ),
    });
    await expect(
      startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps),
    ).rejects.toMatchObject({ code: 'plan_mismatch' });
  });

  it('resumes a pending strategy without signing or creating again', async () => {
    const { deps, calls } = makeDeps({
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(strategy('pending_setup'))
        .mockResolvedValue(strategy('active')),
    });
    await startStrategy(
      {
        amountUsdc: 100,
        settings: DEFAULT_EARN_SETTINGS,
        resumeStrategyId: 's1',
      },
      deps,
    );
    expect(calls).not.toContain('sign');
    expect(calls).not.toContain('createStrategy');
    expect(calls[0]).toBe('listVaults');
    expect(calls).toContain('depositCalldata');
  });

  it('refuses to resume a strategy that is closed', async () => {
    const { deps } = makeDeps({
      getStrategy: vi.fn(async () => strategy('closed')),
    });
    await expect(
      startStrategy(
        {
          amountUsdc: 100,
          settings: DEFAULT_EARN_SETTINGS,
          resumeStrategyId: 's1',
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('starts fresh when a stored resume hint points to a deleted strategy', async () => {
    const { deps, calls } = makeDeps({
      getStrategy: vi
        .fn()
        .mockRejectedValueOnce(
          new EarnApiError(404, 'not_found', 'Strategy not found'),
        )
        .mockResolvedValue(strategy('active')),
    });
    const onStaleResume = vi.fn();
    await startStrategy(
      {
        amountUsdc: 100,
        settings: DEFAULT_EARN_SETTINGS,
        resumeStrategyId: 'old',
        resumeIsHint: true,
        onStaleResume,
      },
      deps,
    );
    expect(onStaleResume).toHaveBeenCalledTimes(1);
    expect(calls).toContain('sign');
    expect(calls).toContain('createStrategy');
  });

  it('starts fresh when a stored resume hint points to a closed strategy', async () => {
    const { deps, calls } = makeDeps({
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(strategy('closed'))
        .mockResolvedValue(strategy('active')),
    });
    const onStaleResume = vi.fn();
    await startStrategy(
      {
        amountUsdc: 100,
        settings: DEFAULT_EARN_SETTINGS,
        resumeStrategyId: 's1',
        resumeIsHint: true,
        onStaleResume,
      },
      deps,
    );
    expect(onStaleResume).toHaveBeenCalledTimes(1);
    expect(calls).toContain('createStrategy');
  });

  it('fails on an explicit resume of a strategy that does not exist', async () => {
    const { deps } = makeDeps({
      getStrategy: vi.fn(async () => {
        throw new EarnApiError(404, 'not_found', 'Strategy not found');
      }),
    });
    await expect(
      startStrategy(
        {
          amountUsdc: 100,
          settings: DEFAULT_EARN_SETTINGS,
          resumeStrategyId: 's1',
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(deps.signMessage).not.toHaveBeenCalled();
  });

  it('returns an already active strategy on resume and sends nothing', async () => {
    const { deps, sent, calls } = makeDeps({
      getStrategy: vi.fn(async () => strategy('active')),
    });
    const result = await startStrategy(
      {
        amountUsdc: 100,
        settings: DEFAULT_EARN_SETTINGS,
        resumeStrategyId: 's1',
      },
      deps,
    );
    expect(result.strategy.status).toBe('active');
    expect(sent).toHaveLength(0);
    expect(calls).not.toContain('depositCalldata');
  });

  it('refuses to resume with an amount that differs from the strategy capital', async () => {
    const { deps, api, sent } = makeDeps({
      getStrategy: vi.fn(async () =>
        strategy('pending_setup', { capital_usdc: 250 }),
      ),
    });
    await expect(
      startStrategy(
        {
          amountUsdc: 5,
          settings: DEFAULT_EARN_SETTINGS,
          resumeStrategyId: 's1',
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'amount_mismatch' });
    expect(api.getApprovals).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('sizes approvals from the strategy capital when resuming', async () => {
    const { deps, api } = makeDeps({
      depositCalldata: vi.fn(async () =>
        depositCalldata({ plan: planFor(SELECTED, 250) }),
      ),
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(strategy('pending_setup', { capital_usdc: 250 }))
        .mockResolvedValue(strategy('active')),
    });
    await startStrategy(
      {
        amountUsdc: 250,
        settings: DEFAULT_EARN_SETTINGS,
        resumeStrategyId: 's1',
      },
      deps,
    );
    expect(
      (api.getApprovals as ReturnType<typeof vi.fn>).mock.calls[0][0]
        .requiredUsdc,
    ).toBe('250000000');
  });

  it('records the deposit hash before waiting for it, then clears it once active', async () => {
    const { deps } = makeDeps();
    const deposits = memoryDeposits();
    deps.deposits = deposits;
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    expect(deposits.set.mock.calls[0]).toEqual(['s1', '0xhash4']);
    const fourthWait = (deps.waitForReceipt as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[3];
    expect(deposits.set.mock.invocationCallOrder[0]).toBeLessThan(fourthWait);
    expect(deposits.set.mock.calls.at(-1)).toEqual(['s1', null]);
  });

  it('does not deposit twice when the recorded deposit was mined', async () => {
    const { deps, sent, calls } = makeDeps({
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(strategy('pending_setup'))
        .mockResolvedValue(strategy('active')),
    });
    deps.deposits = memoryDeposits({ s1: '0xold' });
    const result = await startStrategy(
      {
        amountUsdc: 100,
        settings: DEFAULT_EARN_SETTINGS,
        resumeStrategyId: 's1',
      },
      deps,
    );
    expect(deps.waitForReceipt).toHaveBeenCalledWith('0xold', 8453);
    expect(sent).toHaveLength(0);
    expect(calls).not.toContain('depositCalldata');
    expect(calls).not.toContain('getApprovals');
    expect(result.strategy.status).toBe('active');
  });

  it('deposits again only when the recorded deposit reverted', async () => {
    const { deps, calls, steps } = makeDeps({
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(strategy('pending_setup'))
        .mockResolvedValue(strategy('active')),
    });
    const deposits = memoryDeposits({ s1: '0xold' });
    deps.deposits = deposits;
    deps.waitForReceipt = vi
      .fn()
      .mockRejectedValueOnce(new EarnFlowError('tx_reverted', 'reverted'))
      .mockResolvedValue(undefined);
    const stepAtConfirm: string[] = [];
    const confirm = deps.confirm;
    deps.confirm = vi.fn(async (request: EarnConfirmRequest) => {
      stepAtConfirm.push(steps.at(-1)?.kind ?? '');
      return confirm(request);
    });
    await startStrategy(
      {
        amountUsdc: 100,
        settings: DEFAULT_EARN_SETTINGS,
        resumeStrategyId: 's1',
      },
      deps,
    );
    expect(deposits.set).toHaveBeenCalledWith('s1', null);
    expect(calls).toContain('depositCalldata');
    // The wait screen must not stay up behind the next approval sheet.
    expect(stepAtConfirm).not.toContain('confirming');
    // A resume never goes back to the signature step. After the revert the
    // flow checks the approvals again, so the stepper shows Approve.
    const kinds = steps.map((s) => s.kind);
    expect(kinds).not.toContain('selecting');
    expect(kinds[kinds.indexOf('confirming') + 1]).toBe('resuming');
  });

  it('marks a resumed strategy as resuming, not as choosing vaults', async () => {
    const { deps, steps } = makeDeps({
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(strategy('pending_setup'))
        .mockResolvedValue(strategy('active')),
    });
    await startStrategy(
      {
        amountUsdc: 100,
        settings: DEFAULT_EARN_SETTINGS,
        resumeStrategyId: 's1',
      },
      deps,
    );
    expect(steps[0]).toEqual({ kind: 'resuming' });
    expect(steps.map((s) => s.kind)).not.toContain('selecting');
  });

  it('marks a hinted strategy as resuming once it loads as unfunded', async () => {
    const { deps, steps } = makeDeps({
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(strategy('pending_setup'))
        .mockResolvedValue(strategy('active')),
    });
    await startStrategy(
      {
        amountUsdc: 100,
        settings: DEFAULT_EARN_SETTINGS,
        resumeStrategyId: 's1',
        resumeIsHint: true,
      },
      deps,
    );
    expect(steps.slice(0, 2).map((s) => s.kind)).toEqual([
      'selecting',
      'resuming',
    ]);
  });

  it('never deposits again while the recorded deposit is unknown', async () => {
    const { deps, sent, calls } = makeDeps({
      getStrategy: vi.fn(async () => strategy('pending_setup')),
    });
    deps.deposits = memoryDeposits({ s1: '0xold' });
    deps.waitForReceipt = vi.fn().mockRejectedValue(new Error('Timed out'));
    await expect(
      startStrategy(
        {
          amountUsdc: 100,
          settings: DEFAULT_EARN_SETTINGS,
          resumeStrategyId: 's1',
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'deposit_pending' });
    expect(sent).toHaveLength(0);
    expect(calls).not.toContain('depositCalldata');
  });

  it('polls until the strategy turns active', async () => {
    const getStrategy = vi
      .fn()
      .mockResolvedValueOnce(strategy('pending_setup'))
      .mockResolvedValueOnce(strategy('pending_setup'))
      .mockResolvedValue(strategy('active'));
    const { deps } = makeDeps({ getStrategy });
    const result = await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    expect(getStrategy).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(result.strategy.status).toBe('active');
  });

  it('times out when the strategy never turns active', async () => {
    const { deps } = makeDeps({
      getStrategy: vi.fn(async () => strategy('pending_setup')),
    });
    deps.pollAttempts = 3;
    const error = await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(EarnFlowError);
    expect(error.code).toBe('activation_timeout');
  });
});

describe('withdrawStrategy', () => {
  it('sends share approvals first, then each close transaction, then waits for closed', async () => {
    const approval = {
      chainId: 8453,
      token: SELECTED[0],
      spender: PROXY,
      currentAllowance: '0',
      requiredAllowance: MAX_UINT256,
      tx: {
        to: SELECTED[0],
        data: approveData(PROXY, BigInt(MAX_UINT256)),
        value: '0',
      },
    };
    const { deps, api, calls, steps, sent } = makeDeps({
      withdrawCalldata: vi.fn(async () => ({
        transactions: [
          {
            chainId: 8453,
            to: PROXY,
            data: '0xc105e',
            value: '0',
            gasHint: '310000',
          },
        ],
        approvalsNeeded: [approval],
      })),
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(strategy('closing'))
        .mockResolvedValueOnce(strategy('closing'))
        .mockResolvedValue(strategy('closed')),
    });
    const result = await withdrawStrategy({ strategyId: 's1' }, deps);
    expect(calls).toEqual([
      `send:${SELECTED[0]}`,
      'wait',
      `send:${PROXY}`,
      'wait',
    ]);
    expect(api.getStrategy).toHaveBeenCalledTimes(3);
    expect(steps.find((s) => s.kind === 'approving')).toMatchObject({
      purpose: 'withdraw',
      items: [{ token: SELECTED[0], kind: 'share' }],
    });
    expect(sent[1]).toMatchObject({ gasLimit: 310000n });
    expect(steps.map((s) => s.kind)).toEqual([
      'preparing',
      'approving',
      'withdrawing',
      'confirming',
      'closed',
    ]);
    expect(result.status).toBe('closed');
  });

  it('shows the live value of the positions it withdraws, without paused ones', async () => {
    const position = (usdc_value: number, paused = false) => ({
      id: `p${usdc_value}`,
      vault_name: 'Vault',
      vault_address: SELECTED[0],
      chain_id: 8453,
      usdc_value,
      entry_apy: 5,
      paused,
    });
    const { deps, confirms } = makeDeps({
      withdrawCalldata: vi.fn(async () => ({
        transactions: [
          { chainId: 8453, to: PROXY, data: '0xc105e', value: '0' },
        ],
        approvalsNeeded: [],
      })),
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(
          strategy('active', {
            net_value_usdc: 700.5,
            positions: [
              position(300.25),
              position(300.125),
              position(100.5, true),
            ],
          }),
        )
        .mockResolvedValue(strategy('closed')),
    });
    await withdrawStrategy({ strategyId: 's1' }, deps);
    const review = confirms.find((c) => c.kind === 'withdraw');
    expect(review).toMatchObject({ kind: 'withdraw', amountUsdc: 600.375 });
  });

  it('shows no amount when the strategy lists no positions it withdraws', async () => {
    const { deps, confirms } = makeDeps({
      withdrawCalldata: vi.fn(async () => ({
        transactions: [
          { chainId: 8453, to: PROXY, data: '0xc105e', value: '0' },
        ],
        approvalsNeeded: [],
      })),
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(strategy('active', { net_value_usdc: 600.12 }))
        .mockResolvedValue(strategy('closed')),
    });
    await withdrawStrategy({ strategyId: 's1' }, deps);
    const review = confirms.find((c) => c.kind === 'withdraw');
    expect(review).toBeDefined();
    expect(review).not.toHaveProperty('amountUsdc', expect.anything());
  });

  it('still closes when the strategy read fails', async () => {
    const { deps, confirms, sent } = makeDeps({
      withdrawCalldata: vi.fn(async () => ({
        transactions: [
          { chainId: 8453, to: PROXY, data: '0xc105e', value: '0' },
        ],
        approvalsNeeded: [],
      })),
      getStrategy: vi
        .fn()
        .mockRejectedValueOnce(new Error('429'))
        .mockResolvedValue(strategy('closed')),
    });
    const result = await withdrawStrategy({ strategyId: 's1' }, deps);
    expect(confirms.find((c) => c.kind === 'withdraw')).toMatchObject({
      amountUsdc: undefined,
    });
    expect(sent.at(-1)).toMatchObject({ to: PROXY });
    expect(result.status).toBe('closed');
  });

  it('never deletes a funded strategy, even when the API offers the delete fallback', async () => {
    // All positions are paused, so the API plans no withdrawal.
    const { deps, api, sent } = makeDeps({
      withdrawCalldata: vi.fn(async () => ({
        transactions: [],
        fallback: 'delete',
      })),
      getStrategy: vi.fn(async () => strategy('active')),
    });
    await expect(
      withdrawStrategy({ strategyId: 's1' }, deps),
    ).rejects.toMatchObject({ code: 'funded_close_blocked' });
    expect(deps.signMessage).not.toHaveBeenCalled();
    expect(api.deleteStrategy).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('closes an unfunded strategy with a signed delete', async () => {
    const { deps, api, sent } = makeDeps({
      withdrawCalldata: vi.fn(async () => ({
        transactions: [],
        fallback: 'delete',
      })),
      getStrategy: vi.fn(async () => strategy('pending_setup')),
    });
    await withdrawStrategy({ strategyId: 's1' }, deps);
    const message = (deps.signMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(message).toContain('Authorize strategy.delete');
    expect(message).toContain('- path:/strategies/s1');
    expect(api.deleteStrategy).toHaveBeenCalledWith('s1', {
      siwe: { message, signature: '0xsig' },
    });
    expect(sent).toHaveLength(0);
  });

  it('times out when the strategy never closes', async () => {
    const { deps } = makeDeps({
      getStrategy: vi.fn(async () => strategy('closing')),
    });
    deps.pollAttempts = 2;
    await expect(
      withdrawStrategy({ strategyId: 's1' }, deps),
    ).rejects.toMatchObject({
      code: 'close_timeout',
    });
  });
});

describe('explicit approval before every signature', () => {
  const start = (deps: EarnFlowDeps) =>
    startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps);

  it('asks before each kind of signature, in order, and never signs unasked', async () => {
    const { deps, trace } = makeDeps();
    await start(deps);
    expect(trace).toEqual([
      'confirm:sign_message',
      'sign',
      'confirm:approvals',
      `send:${USDC}`,
      `send:${SELECTED[0]}`,
      `send:${SELECTED[1]}`,
      'confirm:deposit',
      `send:${PROXY}`,
    ]);
  });

  it('shows the exact message that will be signed', async () => {
    const { deps, confirms } = makeDeps();
    await start(deps);
    const signed = (deps.signMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(confirms[0]).toEqual({
      kind: 'sign_message',
      action: 'strategy.create',
      message: signed,
      summary: { capitalUsdc: 100, vaults: summaryVaults(SELECTED) },
    });
    expect(signed).toContain('Authorize strategy.create');
  });

  it('lists every approval with its spender and amount, before any is sent', async () => {
    const { deps, confirms } = makeDeps();
    await start(deps);
    const gate = confirms.find((c) => c.kind === 'approvals');
    expect(gate).toEqual({
      kind: 'approvals',
      purpose: 'deposit',
      batched: false,
      spender: PROXY,
      gas: expect.objectContaining({
        chainId: 8453,
        tx: expect.objectContaining({ to: USDC }),
        count: 3,
      }),
      items: [
        {
          token: USDC,
          label: 'USDC',
          kind: 'usdc',
          chainId: 8453,
          spender: PROXY,
          unlimited: false,
          amountUsdc: 100,
        },
        {
          token: SELECTED[0],
          label: 'Vault 2',
          kind: 'share',
          chainId: 8453,
          spender: PROXY,
          unlimited: true,
        },
        {
          token: SELECTED[1],
          label: 'Vault 6',
          kind: 'share',
          chainId: 8453,
          spender: PROXY,
          unlimited: true,
        },
      ],
    });
  });

  it('shows the amount, the contract, and the vaults before the deposit', async () => {
    const { deps, confirms } = makeDeps();
    await start(deps);
    const gate = confirms.find((c) => c.kind === 'deposit');
    expect(gate).toMatchObject({
      kind: 'deposit',
      amountUsdc: 100,
      chainId: 8453,
      to: PROXY,
    });
    expect(gate?.kind === 'deposit' && gate.vaults.map((v) => v.name)).toEqual([
      'Vault 2',
      'Vault 6',
      'Vault 4',
      'Vault 3',
      'Vault 5',
    ]);
  });

  it('signs nothing and creates nothing when the terms are declined', async () => {
    const { deps, api, sent } = makeDeps({}, { decline: ['sign_message'] });
    await expect(start(deps)).rejects.toMatchObject({ code: 'user_declined' });
    expect(deps.signMessage).not.toHaveBeenCalled();
    expect(api.createStrategy).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('sends no approval when the approvals are declined', async () => {
    const { deps, sent, calls } = makeDeps({}, { decline: ['approvals'] });
    await expect(start(deps)).rejects.toMatchObject({ code: 'user_declined' });
    expect(sent).toHaveLength(0);
    expect(calls).not.toContain('depositCalldata');
  });

  it('sends no deposit and records no hash when the deposit is declined', async () => {
    const { deps, sent } = makeDeps({}, { decline: ['deposit'] });
    const deposits = memoryDeposits();
    deps.deposits = deposits;
    await expect(start(deps)).rejects.toMatchObject({ code: 'user_declined' });
    expect(sent.some((tx) => tx.to === PROXY)).toBe(false);
    expect(deposits.set).not.toHaveBeenCalled();
  });

  it('does not ask for a signature on resume, because none is made', async () => {
    const { deps, trace } = makeDeps({
      getStrategy: vi
        .fn()
        .mockResolvedValueOnce(strategy('pending_setup'))
        .mockResolvedValue(strategy('active')),
    });
    await startStrategy(
      {
        amountUsdc: 100,
        settings: DEFAULT_EARN_SETTINGS,
        resumeStrategyId: 's1',
      },
      deps,
    );
    expect(trace).not.toContain('confirm:sign_message');
    expect(trace).not.toContain('sign');
    expect(trace[0]).toBe('confirm:approvals');
  });

  it('asks before the withdraw approvals and the withdraw transactions', async () => {
    const approval = {
      chainId: 8453,
      token: SELECTED[0],
      spender: PROXY,
      currentAllowance: '0',
      requiredAllowance: MAX_UINT256,
      tx: {
        to: SELECTED[0],
        data: approveData(PROXY, BigInt(MAX_UINT256)),
        value: '0',
      },
    };
    const { deps, trace, confirms } = makeDeps({
      withdrawCalldata: vi.fn(async () => ({
        transactions: [
          { chainId: 8453, to: PROXY, data: '0xc105e', value: '0' },
        ],
        approvalsNeeded: [approval],
      })),
      getStrategy: vi.fn(async () => strategy('closed')),
    });
    await withdrawStrategy({ strategyId: 's1' }, deps);
    expect(trace).toEqual([
      'confirm:approvals',
      `send:${SELECTED[0]}`,
      'confirm:withdraw',
      `send:${PROXY}`,
    ]);
    expect(confirms[0]).toMatchObject({
      kind: 'approvals',
      purpose: 'withdraw',
      spender: PROXY,
      items: [{ token: SELECTED[0], unlimited: true }],
    });
  });

  it('sends no withdraw transaction when the withdrawal is declined', async () => {
    const { deps, sent } = makeDeps(
      {
        getStrategy: vi.fn(async () => strategy('closed')),
      },
      { decline: ['withdraw'] },
    );
    await expect(
      withdrawStrategy({ strategyId: 's1' }, deps),
    ).rejects.toMatchObject({ code: 'user_declined' });
    expect(sent).toHaveLength(0);
  });

  it('asks before it signs a strategy.delete, and signs nothing when declined', async () => {
    const { deps, api } = makeDeps(
      {
        withdrawCalldata: vi.fn(async () => ({
          transactions: [],
          fallback: 'delete',
        })),
        getStrategy: vi.fn(async () => strategy('pending_setup')),
      },
      { decline: ['sign_message'] },
    );
    await expect(
      withdrawStrategy({ strategyId: 's1' }, deps),
    ).rejects.toMatchObject({ code: 'user_declined' });
    expect(deps.signMessage).not.toHaveBeenCalled();
    expect(api.deleteStrategy).not.toHaveBeenCalled();
  });
});

// An open strategy that holds the five chosen vaults.
const heldStrategy = (extra: Record<string, unknown> = {}) =>
  strategy('active', {
    net_value_usdc: 600,
    total_value_usdc: 600,
    positions: SELECTED.map((address, i) => ({
      id: `p${i}`,
      vault_name: `Vault ${i}`,
      vault_address: address,
      chain_id: 8453,
      usdc_value: 120,
      entry_apy: 5,
    })),
    ...extra,
  });

const topUpCalldata = (overrides: Record<string, unknown> = {}) => {
  const plan = (overrides.plan as Plan | undefined) ?? planFor(SELECTED, 50);
  return {
    transactions: [
      {
        chainId: 8453,
        to: PROXY,
        data: depositData(plan),
        value: '0',
        gasHint: '200000',
      },
    ],
    approvalsNeeded: [],
    plan,
    expiresAt: '2026-10-29T13:00:00.000Z',
    ...overrides,
  };
};

const usdcApprovalNeeded = {
  chainId: 8453,
  token: USDC,
  spender: PROXY,
  currentAllowance: '0',
  requiredAllowance: '50000000',
  tx: { to: USDC, data: approveData(PROXY, 50000000n), value: '0' },
};

describe('increase deposit', () => {
  const run = (deps: EarnFlowDeps, amountUsdc = 50) =>
    topUpStrategy({ strategy: heldStrategy(), amountUsdc }, deps);

  it('asks for the amount, then approvals, then the deposit, and sends after each approval', async () => {
    const depositCalldataMock = vi
      .fn()
      .mockResolvedValueOnce(
        topUpCalldata({ approvalsNeeded: [usdcApprovalNeeded] }),
      )
      .mockResolvedValue(topUpCalldata());
    const { deps, api, trace, confirms, steps } = makeDeps({
      depositCalldata: depositCalldataMock,
    });
    await run(deps);
    expect(steps.filter((s) => s.kind === 'approving')).toMatchObject([
      {
        index: 1,
        total: 1,
        purpose: 'deposit',
        items: [{ token: USDC, kind: 'usdc', amountUsdc: 50 }],
      },
    ]);
    expect(api.depositCalldata).toHaveBeenCalledWith('s1', { amountUsdc: 50 });
    expect(trace).toEqual([
      'confirm:approvals',
      `send:${USDC}`,
      'confirm:deposit',
      `send:${PROXY}`,
    ]);
    expect(confirms[0]).toMatchObject({
      kind: 'approvals',
      purpose: 'deposit',
      items: [{ token: USDC, label: 'USDC', unlimited: false, amountUsdc: 50 }],
    });
    expect(confirms[1]).toMatchObject({
      kind: 'deposit',
      amountUsdc: 50,
      to: PROXY,
    });
  });

  it('skips the approvals screen when USDC is already approved', async () => {
    const { deps, trace } = makeDeps({
      depositCalldata: vi.fn(async () => topUpCalldata()),
    });
    await run(deps);
    expect(trace).toEqual(['confirm:deposit', `send:${PROXY}`]);
  });

  // The server's answer without a vault list: USDC plus every vault on the
  // chain, and this wallet never approved two of them.
  const unscopedApprovals = (usdcApproved: boolean) =>
    vi.fn(async () => ({
      ...chainApprovals([]),
      usdc: approvalEntry(USDC, usdcApproved),
      vaults: [...SELECTED, addr(7), addr(8)].map((a, i) =>
        approvalEntry(a, i < SELECTED.length),
      ),
    }));

  it('checks only the USDC approval it sent, not other vaults', async () => {
    const getApprovals = unscopedApprovals(true);
    const { deps, trace } = makeDeps({
      getApprovals,
      depositCalldata: vi
        .fn()
        .mockResolvedValueOnce(
          topUpCalldata({ approvalsNeeded: [usdcApprovalNeeded] }),
        )
        .mockResolvedValue(topUpCalldata()),
    });
    await run(deps);
    expect(getApprovals.mock.calls[0]).toMatchObject([{ vaultKeys: [] }]);
    expect(trace).toEqual([
      'confirm:approvals',
      `send:${USDC}`,
      'confirm:deposit',
      `send:${PROXY}`,
    ]);
  });

  it('stops before the deposit when the USDC approval never shows', async () => {
    const depositCalldataMock = vi
      .fn()
      .mockResolvedValueOnce(
        topUpCalldata({ approvalsNeeded: [usdcApprovalNeeded] }),
      )
      .mockResolvedValue(topUpCalldata());
    const { deps, trace } = makeDeps({
      getApprovals: unscopedApprovals(false),
      depositCalldata: depositCalldataMock,
    });
    await expect(run(deps)).rejects.toMatchObject({
      code: 'approvals_incomplete',
    });
    // The approvals read stops it, before fresh calldata is asked for.
    expect(depositCalldataMock).toHaveBeenCalledTimes(1);
    expect(trace).toEqual(['confirm:approvals', `send:${USDC}`]);
  });

  it('sends nothing when the approvals are declined', async () => {
    const { deps, sent } = makeDeps(
      {
        depositCalldata: vi.fn(async () =>
          topUpCalldata({ approvalsNeeded: [usdcApprovalNeeded] }),
        ),
      },
      { decline: ['approvals'] },
    );
    await expect(run(deps)).rejects.toMatchObject({ code: 'user_declined' });
    expect(sent).toHaveLength(0);
  });

  it('sends no deposit when the deposit is declined', async () => {
    const { deps, sent } = makeDeps(
      { depositCalldata: vi.fn(async () => topUpCalldata()) },
      { decline: ['deposit'] },
    );
    await expect(run(deps)).rejects.toMatchObject({ code: 'user_declined' });
    expect(sent).toHaveLength(0);
  });

  it('refuses a plan that uses a vault the strategy does not hold', async () => {
    const { deps, sent } = makeDeps({
      depositCalldata: vi.fn(async () =>
        topUpCalldata({
          plan: planFor([addr(7)], 50),
        }),
      ),
    });
    await expect(run(deps)).rejects.toMatchObject({ code: 'plan_mismatch' });
    expect(sent).toHaveLength(0);
  });

  it('refuses an amount under the 10 USDC minimum before it calls the API', async () => {
    const { deps, api } = makeDeps();
    await expect(run(deps, 5)).rejects.toMatchObject({ code: 'below_minimum' });
    expect(api.depositCalldata).not.toHaveBeenCalled();
  });

  it('refuses a strategy that is not active', async () => {
    const { deps, api } = makeDeps();
    await expect(
      topUpStrategy(
        { strategy: heldStrategy({ status: 'closing' }), amountUsdc: 50 },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    expect(api.depositCalldata).not.toHaveBeenCalled();
  });

  it('waits for the deposit to be mined', async () => {
    const { deps } = makeDeps({
      depositCalldata: vi.fn(async () => topUpCalldata()),
    });
    await run(deps);
    expect(deps.waitForReceipt).toHaveBeenCalledWith('0xhash1', 8453);
  });

  it('finishes only when the server value includes the increase', async () => {
    const values = [600.01, 600.02, 650.02];
    const { deps, api, steps } = makeDeps({
      depositCalldata: vi.fn(async () => topUpCalldata()),
      getStrategy: vi.fn(async () =>
        heldStrategy({ net_value_usdc: values.shift() ?? 650.02 }),
      ),
    });
    await run(deps);
    expect(api.getStrategy).toHaveBeenCalledTimes(3);
    expect(steps.at(-1)).toEqual({ kind: 'done' });
  });

  // The event-processor raises the value before it counts the deposit, so a
  // read between the two writes would show the increase as yield.
  it('waits until contributed also includes the increase', async () => {
    const reads = [
      heldStrategy({
        net_value_usdc: 650.02,
        contributed_usdc: 600,
        withdrawn_usdc: 0,
      }),
      heldStrategy({
        net_value_usdc: 650.02,
        contributed_usdc: 650,
        withdrawn_usdc: 0,
      }),
    ];
    const { deps, api } = makeDeps({
      depositCalldata: vi.fn(async () => topUpCalldata()),
      getStrategy: vi.fn(async () => reads.shift() ?? heldStrategy()),
    });
    const fresh = await topUpStrategy(
      {
        strategy: heldStrategy({ contributed_usdc: 600, withdrawn_usdc: 0 }),
        amountUsdc: 50,
      },
      deps,
    );
    expect(api.getStrategy).toHaveBeenCalledTimes(2);
    expect(fresh?.contributed_usdc).toBe(650);
  });

  // The server floors contributed at the capital, so fees on a bridged first
  // deposit can absorb part of a small increase. The ledger then moves less
  // than half the increase, and a second read with the moved value suffices.
  it('accepts the moved value on the second read when the ledger moves little', async () => {
    const moved = () =>
      heldStrategy({
        net_value_usdc: 650.02,
        contributed_usdc: 604,
        withdrawn_usdc: 0,
      });
    const { deps, api } = makeDeps({
      depositCalldata: vi.fn(async () => topUpCalldata()),
      getStrategy: vi.fn(async () => moved()),
    });
    const fresh = await topUpStrategy(
      {
        strategy: heldStrategy({ contributed_usdc: 600, withdrawn_usdc: 0 }),
        amountUsdc: 50,
      },
      deps,
    );
    expect(api.getStrategy).toHaveBeenCalledTimes(2);
    expect(fresh?.net_value_usdc).toBe(650.02);
  });

  it('finishes after the wait limit when the value does not move', async () => {
    const { deps, api, steps } = makeDeps({
      depositCalldata: vi.fn(async () => topUpCalldata()),
      getStrategy: vi.fn(async () => heldStrategy()),
    });
    await run(deps);
    expect(api.getStrategy).toHaveBeenCalledTimes(5);
    expect(steps.at(-1)).toEqual({ kind: 'done' });
  });

  it('stops reading the value 130 s after the wait starts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Each slow read takes 50 s.
      const getStrategy = vi.fn(async () => {
        vi.setSystemTime(Date.now() + 50_000);
        return heldStrategy();
      });
      const { deps } = makeDeps({
        depositCalldata: vi.fn(async () => topUpCalldata()),
        getStrategy,
      });
      await run(deps);
      expect(getStrategy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads again after a failed value read', async () => {
    const getStrategy = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(heldStrategy({ net_value_usdc: 650 }));
    const { deps, steps } = makeDeps({
      depositCalldata: vi.fn(async () => topUpCalldata()),
      getStrategy,
    });
    await run(deps);
    expect(getStrategy).toHaveBeenCalledTimes(2);
    expect(steps.at(-1)).toEqual({ kind: 'done' });
  });
});

describe('decrease deposit', () => {
  const partial = { feeUsdc: 0, receiveUsdc: 100 };
  const withdrawResponse = (overrides: Record<string, unknown> = {}) => ({
    transactions: [
      {
        chainId: 8453,
        to: PROXY,
        data: '0xc105e',
        value: '0',
        gasHint: '250000',
        description: 'Withdraw $100',
      },
    ],
    approvalsNeeded: [],
    partial,
    ...overrides,
  });
  const run = (deps: EarnFlowDeps, amountUsdc = 100) =>
    partialWithdraw({ strategyId: 's1', amountUsdc }, deps);

  it('asks the API for that amount and asks before the transaction', async () => {
    const { deps, api, trace, confirms } = makeDeps({
      withdrawCalldata: vi.fn(async () => withdrawResponse()),
    });
    await run(deps);
    expect(api.withdrawCalldata).toHaveBeenCalledWith('s1', {
      amountUsdc: 100,
    });
    expect(trace).toEqual(['confirm:withdraw', `send:${PROXY}`]);
    expect(confirms[0]).toMatchObject({
      kind: 'withdraw',
      partial: { amountUsdc: 100, feeUsdc: 0, receiveUsdc: 100 },
    });
  });

  it('gives the fee picker the transaction and its gas, apart from the bridge fee', async () => {
    const { deps, confirms } = makeDeps({
      withdrawCalldata: vi.fn(async () =>
        withdrawResponse({ partial: { feeUsdc: 0.4, receiveUsdc: 99.6 } }),
      ),
    });
    const estimateGas = vi.fn(async (_: EarnSendRequest) => 200_000n);
    deps.estimateGas = estimateGas;
    await run(deps);
    // The estimate is below the server's hint, so the hint counts.
    expect(confirms[0]).toMatchObject({
      kind: 'withdraw',
      partial: { feeUsdc: 0.4 },
      gas: { chainId: 8453, tx: { to: PROXY }, gasLimit: 250_000n, count: 1 },
    });
    expect(estimateGas.mock.calls[0][0]).toMatchObject({ to: PROXY });
  });

  it('asks before the share approvals when the API needs them', async () => {
    const approval = {
      chainId: 8453,
      token: SELECTED[0],
      spender: PROXY,
      currentAllowance: '0',
      requiredAllowance: MAX_UINT256,
      tx: {
        to: SELECTED[0],
        data: approveData(PROXY, BigInt(MAX_UINT256)),
        value: '0',
      },
    };
    const { deps, trace } = makeDeps({
      withdrawCalldata: vi.fn(async () =>
        withdrawResponse({ approvalsNeeded: [approval] }),
      ),
    });
    await run(deps);
    expect(trace).toEqual([
      'confirm:approvals',
      `send:${SELECTED[0]}`,
      'confirm:withdraw',
      `send:${PROXY}`,
    ]);
  });

  it('sends nothing when the withdrawal is declined', async () => {
    const { deps, sent } = makeDeps(
      { withdrawCalldata: vi.fn(async () => withdrawResponse()) },
      { decline: ['withdraw'] },
    );
    await expect(run(deps)).rejects.toMatchObject({ code: 'user_declined' });
    expect(sent).toHaveLength(0);
  });

  it('never signs a strategy.delete, whatever the API answers', async () => {
    const { deps, api } = makeDeps({
      withdrawCalldata: vi.fn(async () => ({
        transactions: [],
        fallback: 'delete',
      })),
    });
    await expect(run(deps)).rejects.toMatchObject({
      code: 'nothing_to_withdraw',
    });
    expect(deps.signMessage).not.toHaveBeenCalled();
    expect(api.deleteStrategy).not.toHaveBeenCalled();
  });

  it('refuses an amount that is not positive before it calls the API', async () => {
    const { deps, api } = makeDeps();
    await expect(run(deps, 0)).rejects.toMatchObject({
      code: 'invalid_amount',
    });
    expect(api.withdrawCalldata).not.toHaveBeenCalled();
  });

  it('finishes only when the server value drops by the amount', async () => {
    const values = [600.01, 500.01];
    const { deps, api, steps } = makeDeps({
      withdrawCalldata: vi.fn(async () => withdrawResponse()),
      getStrategy: vi.fn(async () =>
        heldStrategy({ net_value_usdc: values.shift() ?? 500.01 }),
      ),
    });
    await partialWithdraw(
      { strategyId: 's1', amountUsdc: 100, valueBeforeUsdc: 600 },
      deps,
    );
    expect(api.getStrategy).toHaveBeenCalledTimes(2);
    expect(steps.at(-2)).toEqual({ kind: 'confirming' });
    expect(steps.at(-1)).toEqual({ kind: 'done' });
  });
});

describe('change strategy settings', () => {
  const patch = { delta_pct: 4, delta_confirmations: 6 };
  const run = (deps: EarnFlowDeps) =>
    updateStrategySettings({ strategyId: 's1', patch }, deps);

  it('asks before it signs, and shows the exact message', async () => {
    const { deps, confirms, trace } = makeDeps({
      updateStrategy: vi.fn(async () => heldStrategy(patch)),
    });
    await run(deps);
    expect(trace).toEqual(['confirm:sign_message', 'sign']);
    const gate = confirms[0];
    expect(gate).toMatchObject({
      kind: 'sign_message',
      action: 'strategy.update',
    });
    expect(gate.kind === 'sign_message' && gate.message).toContain(
      '- path:/strategies/s1',
    );
  });

  it('sends the signed patch and returns the updated strategy', async () => {
    const { deps, api } = makeDeps({
      updateStrategy: vi.fn(async () => heldStrategy(patch)),
    });
    const updated = await run(deps);
    const [id, body] = (api.updateStrategy as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(id).toBe('s1');
    expect(body).toMatchObject({ ...patch, siwe: { signature: '0xsig' } });
    expect(updated).toMatchObject(patch);
  });

  it('signs nothing and changes nothing when declined', async () => {
    const { deps, api } = makeDeps(
      { updateStrategy: vi.fn(async () => heldStrategy(patch)) },
      { decline: ['sign_message'] },
    );
    await expect(run(deps)).rejects.toMatchObject({ code: 'user_declined' });
    expect(deps.signMessage).not.toHaveBeenCalled();
    expect(api.updateStrategy).not.toHaveBeenCalled();
  });

  it('refuses a value the server would reject, before it signs', async () => {
    const { deps } = makeDeps();
    await expect(
      updateStrategySettings(
        { strategyId: 's1', patch: { delta_pct: 0.1 } },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'invalid_settings' });
    expect(deps.signMessage).not.toHaveBeenCalled();
  });
});

describe('reviews match what is sent', () => {
  const ELSEWHERE = addr(99);
  const start = (deps: EarnFlowDeps) =>
    startStrategy({ amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS }, deps);
  // The plan on the sheet stays the same. Only the transaction differs.
  const withDepositTx = (tx: { to?: string; data?: string }) =>
    vi.fn(async () => {
      const calldata = depositCalldata();
      return {
        ...calldata,
        transactions: [{ ...calldata.transactions[0], ...tx }],
      };
    });

  it.each([
    [
      'deposits into other vaults',
      {
        data: depositData(
          planFor([addr(2), addr(6), addr(4), addr(3), addr(7)]),
        ),
      },
    ],
    [
      'splits the amount another way',
      {
        data: depositData({
          vaults: SELECTED,
          amounts: ['40000000', '15000000', '15000000', '15000000', '15000000'],
        }),
      },
    ],
    [
      'bridges part of the amount away',
      { data: depositData(planFor(SELECTED), [BURN]) },
    ],
    ['is not a deposit call', { data: '0xdeadbeef' }],
    ['goes to another contract than the approvals named', { to: ELSEWHERE }],
  ])(
    'refuses a deposit transaction that %s, before the sheet',
    async (_, tx) => {
      const { deps, confirms, sent } = makeDeps({
        depositCalldata: withDepositTx(tx),
      });
      await expect(start(deps)).rejects.toMatchObject({
        code: 'plan_mismatch',
      });
      expect(confirms.some((c) => c.kind === 'deposit')).toBe(false);
      expect(sent.some((t) => t.to === PROXY || t.to === ELSEWHERE)).toBe(
        false,
      );
    },
  );

  it('refuses a plan that does not add up to the amount', async () => {
    const { deps, sent } = makeDeps({
      depositCalldata: vi.fn(async () =>
        depositCalldata({ plan: planFor(SELECTED, 90) }),
      ),
    });
    await expect(start(deps)).rejects.toMatchObject({ code: 'plan_mismatch' });
    expect(sent.some((t) => t.to === PROXY)).toBe(false);
  });

  it('refuses an increase whose transaction differs from the plan it shows', async () => {
    const { deps, sent } = makeDeps({
      depositCalldata: vi.fn(async () => {
        const calldata = topUpCalldata();
        return {
          ...calldata,
          transactions: [
            {
              ...calldata.transactions[0],
              data: depositData({
                vaults: SELECTED,
                amounts: ['50000000', '0', '0', '0', '0'],
              }),
            },
          ],
        };
      }),
    });
    await expect(
      topUpStrategy({ strategy: heldStrategy(), amountUsdc: 50 }, deps),
    ).rejects.toMatchObject({ code: 'plan_mismatch' });
    expect(sent).toHaveLength(0);
  });

  it('shows the vaults that rank highest with the create signature', async () => {
    const three = SELECTED.slice(0, 3);
    const { deps, confirms } = makeDeps({
      rankVaults: vi.fn(async () => three.map((a) => vaultKey(8453, a))),
      depositCalldata: vi.fn(async () =>
        depositCalldata({ plan: planFor(three) }),
      ),
    });
    await start(deps);
    expect(confirms.find((c) => c.kind === 'sign_message')).toMatchObject({
      summary: { vaults: summaryVaults(three) },
    });
  });

  it('refuses a "USDC" approval for a token that is not USDC', async () => {
    const { deps, sent } = makeDeps({
      getApprovals: vi.fn(async () => ({
        ...chainApprovals([0]),
        usdc: {
          ...approvalEntry(ELSEWHERE, false),
          tx: {
            to: ELSEWHERE,
            data: approveData(PROXY, 100000000n),
            value: '0',
          },
        },
      })),
    });
    await expect(start(deps)).rejects.toMatchObject({
      code: 'approval_mismatch',
    });
    expect(sent).toHaveLength(0);
  });

  it('stops a decrease before any sheet when the server sends no fee quote', async () => {
    const { deps, confirms, sent } = makeDeps({
      withdrawCalldata: vi.fn(async () => ({
        transactions: [
          {
            chainId: 8453,
            to: PROXY,
            data: '0xc105e',
            value: '0',
            gasHint: '250000',
          },
        ],
        approvalsNeeded: [],
      })),
    });
    await expect(
      partialWithdraw({ strategyId: 's1', amountUsdc: 100 }, deps),
    ).rejects.toMatchObject({ code: 'no_quote' });
    expect(confirms).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  // Each deposit-calldata call counts against a limit of 24 an hour.
  it('after an increase approval, polls the approvals read, then asks for calldata once', async () => {
    const depositCalldataMock = vi
      .fn()
      .mockResolvedValueOnce(
        topUpCalldata({ approvalsNeeded: [usdcApprovalNeeded] }),
      )
      .mockResolvedValue(topUpCalldata());
    const getApprovals = vi
      .fn()
      .mockResolvedValueOnce({
        ...allApproved(),
        usdc: approvalEntry(USDC, false),
      })
      .mockResolvedValue(allApproved());
    const { deps } = makeDeps({
      depositCalldata: depositCalldataMock,
      getApprovals,
    });
    await topUpStrategy({ strategy: heldStrategy(), amountUsdc: 50 }, deps);
    expect(getApprovals).toHaveBeenCalledTimes(2);
    expect(getApprovals.mock.calls[0][0]).toEqual({
      address: ADDRESS,
      chainId: 8453,
      requiredUsdc: '50000000',
      vaultKeys: [],
    });
    expect(depositCalldataMock).toHaveBeenCalledTimes(2);
  });

  it('returns the fresh strategy once its value shows the change', async () => {
    const up = makeDeps({
      depositCalldata: vi.fn(async () => topUpCalldata()),
      getStrategy: vi.fn(async () => heldStrategy({ net_value_usdc: 650 })),
    });
    await expect(
      topUpStrategy({ strategy: heldStrategy(), amountUsdc: 50 }, up.deps),
    ).resolves.toMatchObject({ net_value_usdc: 650 });
    const down = makeDeps({
      withdrawCalldata: vi.fn(async () => ({
        transactions: [
          { chainId: 8453, to: PROXY, data: '0xc105e', value: '0' },
        ],
        approvalsNeeded: [],
        partial: { feeUsdc: 0, receiveUsdc: 100 },
      })),
      getStrategy: vi.fn(async () => heldStrategy({ net_value_usdc: 500 })),
    });
    await expect(
      partialWithdraw(
        { strategyId: 's1', amountUsdc: 100, valueBeforeUsdc: 600 },
        down.deps,
      ),
    ).resolves.toMatchObject({ net_value_usdc: 500 });
  });

  it('shows each setting it changes, from the old value to the new one', async () => {
    const { deps, confirms } = makeDeps({
      updateStrategy: vi.fn(async () => heldStrategy({ delta_pct: 4 })),
    });
    await updateStrategySettings(
      {
        strategyId: 's1',
        patch: { delta_pct: 4, min_tvl_usd: 1 },
        before: { delta_pct: 2, min_tvl_usd: 1_000_000 },
      },
      deps,
    );
    expect(confirms[0]).toMatchObject({
      kind: 'sign_message',
      changes: [
        { field: 'delta_pct', from: 2, to: 4 },
        { field: 'min_tvl_usd', from: 1_000_000, to: 1 },
      ],
    });
  });
});

describe('increase without approvals', () => {
  it('still checks the deposit goes to the Earn contract', async () => {
    const { deps, sent } = makeDeps({
      depositCalldata: vi.fn(async () => {
        const calldata = topUpCalldata();
        return {
          ...calldata,
          transactions: [{ ...calldata.transactions[0], to: addr(99) }],
        };
      }),
    });
    await expect(
      topUpStrategy({ strategy: heldStrategy(), amountUsdc: 50 }, deps),
    ).rejects.toMatchObject({ code: 'plan_mismatch' });
    expect(sent).toHaveLength(0);
  });
});

describe('gas for the fee picker on the reviews', () => {
  const estimateBy = () => vi.fn(async (_: EarnSendRequest) => 60_000n);

  it('gives the approvals and the deposit of a new strategy their gas', async () => {
    const { deps, confirms } = makeDeps();
    const estimateGas = estimateBy();
    deps.estimateGas = estimateGas;
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    // Three approvals with no hint: three estimates, added up.
    expect(confirms.find((c) => c.kind === 'approvals')).toMatchObject({
      gas: { chainId: 8453, tx: { to: USDC }, gasLimit: 180_000n, count: 3 },
    });
    // The deposit never goes below the server's hint.
    expect(confirms.find((c) => c.kind === 'deposit')).toMatchObject({
      gas: { chainId: 8453, tx: { to: PROXY }, gasLimit: 231_000n, count: 1 },
    });
    expect(estimateGas.mock.calls.map(([tx]) => tx.to)).toEqual([
      USDC,
      SELECTED[0],
      SELECTED[1],
      PROXY,
    ]);
  });

  it('still shows every review when an estimate fails', async () => {
    const { deps, confirms } = makeDeps();
    deps.estimateGas = vi.fn(async () => {
      throw new Error('rpc down');
    });
    const result = await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    expect(result.strategy.status).toBe('active');
    // Without every estimate there is no total. The picker prices the first
    // transaction itself.
    const approvals = confirms.find((c) => c.kind === 'approvals');
    expect(approvals).toMatchObject({ gas: { tx: { to: USDC }, count: 3 } });
    expect(approvals).not.toHaveProperty('gas.gasLimit', expect.anything());
    expect(confirms.find((c) => c.kind === 'deposit')).toMatchObject({
      gas: { gasLimit: 231_000n },
    });
  });

  it('gives the withdrawal approvals and the close their gas', async () => {
    const approval = {
      chainId: 8453,
      token: SELECTED[0],
      spender: PROXY,
      currentAllowance: '0',
      requiredAllowance: MAX_UINT256,
      tx: {
        to: SELECTED[0],
        data: approveData(PROXY, BigInt(MAX_UINT256)),
        value: '0',
      },
    };
    const { deps, confirms } = makeDeps({
      withdrawCalldata: vi.fn(async () => ({
        transactions: [
          {
            chainId: 8453,
            to: PROXY,
            data: '0xc105e',
            value: '0',
            gasHint: '310000',
          },
        ],
        approvalsNeeded: [approval],
      })),
      getStrategy: vi.fn(async () => strategy('closed')),
    });
    deps.estimateGas = estimateBy();
    await withdrawStrategy({ strategyId: 's1' }, deps);
    expect(confirms.find((c) => c.kind === 'approvals')).toMatchObject({
      gas: { tx: { to: SELECTED[0] }, gasLimit: 60_000n, count: 1 },
    });
    expect(confirms.find((c) => c.kind === 'withdraw')).toMatchObject({
      gas: { tx: { to: PROXY }, gasLimit: 310_000n, count: 1 },
    });
  });

  it('gives an increase approval and the increase their gas', async () => {
    const depositCalldataMock = vi
      .fn()
      .mockResolvedValueOnce(
        topUpCalldata({ approvalsNeeded: [usdcApprovalNeeded] }),
      )
      .mockResolvedValue(topUpCalldata());
    const { deps, confirms } = makeDeps({
      depositCalldata: depositCalldataMock,
    });
    deps.estimateGas = estimateBy();
    await topUpStrategy({ strategy: heldStrategy(), amountUsdc: 50 }, deps);
    expect(confirms.find((c) => c.kind === 'approvals')).toMatchObject({
      gas: { tx: { to: USDC }, gasLimit: 60_000n, count: 1 },
    });
    expect(confirms.find((c) => c.kind === 'deposit')).toMatchObject({
      gas: { tx: { to: PROXY }, gasLimit: 200_000n, count: 1 },
    });
  });

  it('counts only the transactions on the chain the picker prices', async () => {
    const { deps, confirms } = makeDeps({
      withdrawCalldata: vi.fn(async () => ({
        transactions: [
          {
            chainId: 8453,
            to: PROXY,
            data: '0xc105e',
            value: '0',
            gasHint: '310000',
          },
          {
            chainId: 1,
            to: PROXY,
            data: '0xc105e',
            value: '0',
            gasHint: '400000',
          },
        ],
        approvalsNeeded: [],
      })),
      getStrategy: vi.fn(async () => strategy('closed')),
    });
    deps.estimateGas = estimateBy();
    await withdrawStrategy({ strategyId: 's1' }, deps);
    expect(confirms.find((c) => c.kind === 'withdraw')).toMatchObject({
      gas: { chainId: 8453, gasLimit: 310_000n, count: 1 },
    });
  });
});

describe('gas estimate limits', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens each review after 3 s when the estimate hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { deps, confirms } = makeDeps();
    deps.estimateGas = vi.fn(
      () =>
        new Promise<bigint>(() => {
          // Never answers.
        }),
    );
    const done = startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      deps,
    );
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(confirms.find((c) => c.kind === 'approvals')).not.toHaveProperty(
      'gas.gasLimit',
      expect.anything(),
    );
    expect(confirms.find((c) => c.kind === 'deposit')).toMatchObject({
      gas: { gasLimit: 231_000n },
    });
  });

  it('gives a Smart Wallet batch no fee picker, because it prices itself', async () => {
    const made = makeDeps();
    made.deps.canBatch = vi.fn(async () => true);
    made.deps.sendBatch = vi.fn(async () => undefined);
    made.deps.estimateGas = vi.fn(async (_: EarnSendRequest) => 60_000n);
    await startStrategy(
      { amountUsdc: 100, settings: DEFAULT_EARN_SETTINGS },
      made.deps,
    );
    const approvals = made.confirms.find((c) => c.kind === 'approvals');
    expect(approvals).toMatchObject({ batched: true });
    expect(approvals).not.toHaveProperty('gas', expect.anything());
  });
});
