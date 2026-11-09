import {
  Address,
  Hex,
  decodeFunctionData,
  erc20Abi,
  formatUnits,
  parseUnits,
} from 'viem';

import { SELF_BATCH_DEPOSIT_ABI } from './abi';
import { type EarnApi, EarnApiError } from './api';
import { minStrategyUsdc } from './config';
import {
  EARN_STRATEGY_NAME,
  USDC_BASE_ADDRESS,
  USDC_DECIMALS,
} from './defaults';
import { sendGasLimit } from './fees';
import { signWrite } from './siwe';
import type {
  EarnApprovalEntry,
  EarnDepositCalldata,
  EarnSettings,
  EarnStrategy,
  EarnVault,
  EarnWithdrawCalldata,
} from './types';
import {
  pickVisibleVaults,
  rankedVaults,
  vaultKey,
  visibleVaultsOf,
  withoutHiddenVaults,
} from './vaults';

export type EarnFlowStep =
  | { kind: 'selecting' }
  | { kind: 'resuming' }
  | { kind: 'signing' }
  | { kind: 'creating' }
  | {
      kind: 'approving';
      index: number;
      total: number;
      // One token, or every token of a Smart Wallet batch.
      items: EarnApprovalItem[];
      purpose: 'deposit' | 'withdraw';
    }
  | { kind: 'depositing' }
  | { kind: 'preparing' }
  | { kind: 'withdrawing'; index: number; total: number }
  | { kind: 'confirming' }
  | { kind: 'active'; strategyId: string }
  | { kind: 'saving' }
  | { kind: 'done' }
  | { kind: 'closed' };

export type EarnSendRequest = {
  chainId: number;
  to: Address;
  data: Hex;
  gasLimit?: bigint;
};

// gasLimit is the total for the review's transactions on chainId. It is
// missing when one of them has no estimate.
export type EarnReviewGas = {
  chainId: number;
  tx: EarnSendRequest;
  gasLimit?: bigint;
  count: number;
};

// Built from the decoded approve calldata, so the sheet shows what gets signed.
export type EarnApprovalItem = {
  token: string;
  label?: string;
  kind: 'usdc' | 'share';
  chainId: number;
  spender: string;
  unlimited: boolean;
  amountUsdc?: number;
};

// The wallet shows exactly this before it signs or sends anything.
export type EarnConfirmRequest =
  | {
      kind: 'sign_message';
      action: string;
      message: string;
      // Set for strategy.create. The vaults are the server's ranking at create
      // time; the deposit review shows the final split.
      summary?: {
        capitalUsdc: number;
        vaults: Array<{ address: string; name: string; apy: number | null }>;
      };
      // Each setting a strategy.update changes. The message holds only a hash.
      changes?: Array<{
        field: keyof StrategyPatch;
        from?: number;
        to: number;
      }>;
    }
  | {
      kind: 'approvals';
      purpose: 'deposit' | 'withdraw';
      spender: string;
      items: EarnApprovalItem[];
      batched?: boolean;
      gas?: EarnReviewGas;
    }
  | {
      kind: 'deposit';
      amountUsdc: number;
      chainId: number;
      to: string;
      vaults: Array<{ address: string; name: string; amountUsdc: number }>;
      gas?: EarnReviewGas;
    }
  | {
      kind: 'withdraw';
      partial?: { amountUsdc: number; feeUsdc: number; receiveUsdc: number };
      // Set for a close: the live value of the positions it withdraws.
      amountUsdc?: number;
      gas?: EarnReviewGas;
      transactions: Array<{
        chainId: number;
        to: string;
        description?: string;
      }>;
    };

export interface EarnFlowDeps {
  api: EarnApi;
  address: Address;
  chainId: number;
  siwe: { domain: string; uri: string };
  // Resolves true only when the user approves. Nothing signs or sends before.
  confirm: (request: EarnConfirmRequest) => Promise<boolean>;
  signMessage: (message: string) => Promise<Hex>;
  sendTransaction: (tx: EarnSendRequest) => Promise<{ hash: Hex }>;
  waitForReceipt: (hash: Hex, chainId: number) => Promise<void>;
  // Rainbow Smart Wallet (EIP-7702) batch. `canBatch` must not sign or send.
  canBatch?: (chainId: number) => Promise<boolean>;
  sendBatch?: (txs: EarnSendRequest[]) => Promise<void>;
  // Deposit hashes by strategy id. They stop a resume from depositing twice.
  deposits?: {
    get: (strategyId: string) => Hex | undefined;
    set: (strategyId: string, hash: Hex | null) => void;
  };
  onStep?: (step: EarnFlowStep) => void;
  // Padded estimate for the review. Must not sign or send. Null when unknown.
  estimateGas?: (tx: EarnSendRequest) => Promise<bigint | null>;
  sleep?: (ms: number) => Promise<void>;
  pollAttempts?: number;
  pollIntervalMs?: number;
  approvalAttempts?: number;
}

export class EarnFlowError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EarnFlowError';
    this.code = code;
  }
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// Only `askUser` creates a Grant, and every sign or send needs one, so the
// compiler rejects a signature the user was not asked about.
declare const grantBrand: unique symbol;
type Grant = { readonly [grantBrand]: true };

async function askUser(
  deps: EarnFlowDeps,
  request: EarnConfirmRequest,
): Promise<Grant> {
  const approved = await deps.confirm(request);
  if (!approved) {
    throw new EarnFlowError(
      'user_declined',
      'You declined. Nothing more was signed or sent.',
    );
  }
  return {} as Grant;
}

// The unnamed `_` parameter is the grant. Its type is the whole point.
function signWithGrant(
  deps: EarnFlowDeps,
  message: string,
  _: Grant,
): Promise<Hex> {
  return deps.signMessage(message);
}

async function sendWithGrant(
  deps: EarnFlowDeps,
  tx: EarnSendRequest,
  _: Grant,
): Promise<Hex> {
  const { hash } = await deps.sendTransaction(tx);
  return hash;
}

async function sendBatchWithGrant(
  deps: EarnFlowDeps,
  txs: EarnSendRequest[],
  _: Grant,
): Promise<void> {
  if (!deps.sendBatch) throw new Error('No batch sender');
  try {
    await deps.sendBatch(txs);
  } catch (e) {
    if (e instanceof EarnFlowError) throw e;
    // The grant covered this batch only. Single sends need a new approval.
    throw new EarnFlowError(
      'batch_failed',
      'The approval transaction failed. Nothing was deposited. Try again.',
    );
  }
}

async function sendAndWait(
  deps: EarnFlowDeps,
  tx: EarnSendRequest,
  grant: Grant,
): Promise<void> {
  const hash = await sendWithGrant(deps, tx, grant);
  await deps.waitForReceipt(hash, tx.chainId);
}

const UNLIMITED_ALLOWANCE = 2n ** 255n;

const approvalMismatch = () =>
  new EarnFlowError(
    'approval_mismatch',
    'An approval from the Earn service does not match what it describes. Nothing was signed.',
  );

// Any difference from what the Earn service declared stops the flow before
// the approval sheet.
function checkedApproval({
  token,
  chainId,
  spender,
  tx,
  label,
  isUsdc,
}: {
  token: string;
  chainId: number;
  spender: string;
  tx: { to: string; data: string };
  label?: string;
  isUsdc: boolean;
}): EarnApprovalItem {
  if (isUsdc && token.toLowerCase() !== USDC_BASE_ADDRESS.toLowerCase()) {
    throw approvalMismatch();
  }
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex });
  } catch {
    throw approvalMismatch();
  }
  if (decoded.functionName !== 'approve') throw approvalMismatch();
  const [approvedSpender, amount] = decoded.args;
  if (
    tx.to.toLowerCase() !== token.toLowerCase() ||
    approvedSpender.toLowerCase() !== spender.toLowerCase()
  ) {
    throw approvalMismatch();
  }
  const unlimited = amount >= UNLIMITED_ALLOWANCE;
  return {
    token,
    label,
    kind: isUsdc ? 'usdc' : 'share',
    chainId,
    spender,
    unlimited,
    ...(isUsdc && !unlimited
      ? { amountUsdc: Number(formatUnits(amount, USDC_DECIMALS)) }
      : {}),
  };
}

const planMismatch = () =>
  new EarnFlowError(
    'plan_mismatch',
    'The deposit plan does not match the chosen vaults. Nothing was sent.',
  );

// The sheet shows the plan, so the calldata must match it exactly.
function checkDeposit({
  tx,
  plan,
  amountUsdc,
  spender,
}: {
  tx: { to: string; data: string };
  plan: { vaults: string[]; amounts: string[] };
  amountUsdc: number;
  spender?: string;
}) {
  let decoded;
  try {
    decoded = decodeFunctionData({
      abi: SELF_BATCH_DEPOSIT_ABI,
      data: tx.data as Hex,
    });
  } catch {
    throw planMismatch();
  }
  const [vaults, amounts, burns] = decoded.args;
  const samePlan =
    vaults.length === plan.vaults.length &&
    amounts.length === plan.amounts.length &&
    vaults.every(
      (vault, i) =>
        vault.toLowerCase() === plan.vaults[i].toLowerCase() &&
        amounts[i].toString() === plan.amounts[i],
    );
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  if (
    !samePlan ||
    burns.length > 0 ||
    total !== parseUnits(amountUsdc.toFixed(USDC_DECIMALS), USDC_DECIMALS) ||
    (spender !== undefined && tx.to.toLowerCase() !== spender.toLowerCase())
  ) {
    throw planMismatch();
  }
}

// One sheet names one spender. Refuse a group that mixes spenders.
function commonSpender(spenders: string[]): string {
  const first = spenders[0] ?? '';
  if (spenders.some((s) => s.toLowerCase() !== first.toLowerCase())) {
    throw approvalMismatch();
  }
  return first;
}

const nameOfVault = (vaults: EarnVault[], address: string) =>
  vaults.find((v) => v.vaultAddress.toLowerCase() === address.toLowerCase())
    ?.name;

async function pollStrategy(
  deps: EarnFlowDeps,
  strategyId: string,
  isDone: (strategy: EarnStrategy) => boolean,
  timeoutCode: string,
): Promise<EarnStrategy> {
  const attempts = deps.pollAttempts ?? 60;
  const interval = deps.pollIntervalMs ?? 5000;
  const sleep = deps.sleep ?? defaultSleep;
  for (let i = 0; i < attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const strategy = await deps.api.getStrategy(strategyId);
    if (isDone(strategy)) return strategy;
    // eslint-disable-next-line no-await-in-loop
    if (i < attempts - 1) await sleep(interval);
  }
  throw new EarnFlowError(
    timeoutCode,
    'The strategy did not reach its final state in time. Check Activity and try again.',
  );
}

const APPROVAL_RECHECK_MS = 2000;

// The server reads allowances through its own RPC, which can lag a block, and
// its ranking drops a vault it sees as unapproved. Only the requested vaults
// count: without a vault list the server reports every vault on the chain.
async function confirmApprovals(
  deps: EarnFlowDeps,
  request: Parameters<EarnApi['getApprovals']>[0],
  minAttempts = 10,
): Promise<void> {
  const attempts = deps.approvalAttempts ?? minAttempts;
  const sleep = deps.sleep ?? defaultSleep;
  const requested = new Set(request.vaultKeys);
  for (let i = 0; i < attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const read = await deps.api.getApprovals(request);
    const asked = read.vaults.filter((entry) =>
      requested.has(
        vaultKey(request.chainId, entry.vaultAddress ?? entry.token),
      ),
    );
    if ([read.usdc, ...asked].every((entry) => !entry || entry.approved)) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    if (i < attempts - 1) await sleep(APPROVAL_RECHECK_MS);
  }
  throw new EarnFlowError(
    'approvals_incomplete',
    'The approvals are not confirmed yet. Nothing was deposited. Try again.',
  );
}

const VALUE_RECHECK_MS = 2000;
const VALUE_ATTEMPTS = 65;
const VALUE_WAIT_MS = 130_000;

// The server value moves only after its event pipeline records the mined
// transaction. Share prices drift every block, so "moved" means nearer the
// expected value than the old one. The cap or 130 s ends the wait without an
// error, because the transaction is already mined. 130 s covers one missed
// webhook and one sweep minute.
//
// After an increase the ledger must move too: the event-processor raises the
// value before it counts the deposit, so a read between the two shows the
// increase as yield. A second read with the moved value is accepted anyway,
// because the server floors contributed at the capital and fees can hold the
// ledger back. A decrease needs no ledger check: the server records the
// withdrawal first.
const ledgerOf = (s?: EarnStrategy) =>
  s && Number.isFinite(s.contributed_usdc) && Number.isFinite(s.withdrawn_usdc)
    ? (s.contributed_usdc as number) - (s.withdrawn_usdc as number)
    : undefined;

async function waitForNewValue(
  deps: EarnFlowDeps,
  strategyId: string,
  before: number | undefined,
  change: number,
  ledgerBefore?: number,
): Promise<EarnStrategy | undefined> {
  if (before === undefined) return undefined;
  const expected = before + change;
  const attempts = deps.pollAttempts ?? VALUE_ATTEMPTS;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + VALUE_WAIT_MS;
  let movedBefore = false;
  for (let i = 0; i < attempts && Date.now() < deadline; i += 1) {
    let fresh: EarnStrategy | undefined;
    try {
      // eslint-disable-next-line no-await-in-loop
      fresh = await deps.api.getStrategy(strategyId);
    } catch {
      fresh = undefined;
    }
    const now = fresh?.net_value_usdc;
    const ledger = ledgerOf(fresh);
    const ledgerMoved =
      ledgerBefore === undefined ||
      ledger === undefined ||
      Math.abs(ledger - (ledgerBefore + change)) <
        Math.abs(ledger - ledgerBefore);
    const moved =
      now !== undefined && Math.abs(now - expected) < Math.abs(now - before);
    if (moved && (ledgerMoved || movedBefore)) return fresh;
    movedBefore = moved;
    // eslint-disable-next-line no-await-in-loop
    if (i < attempts - 1) await sleep(VALUE_RECHECK_MS);
  }
  return undefined;
}

const gasLimitOf = (gasHint?: string | null) =>
  gasHint ? BigInt(gasHint) : undefined;

const sendRequestOf = (tx: {
  chainId: number;
  to: string;
  data: string;
  gasHint?: string | null;
}): EarnSendRequest => ({
  chainId: tx.chainId,
  to: tx.to as Address,
  data: tx.data as Hex,
  gasLimit: gasLimitOf(tx.gasHint),
});

const GAS_WAIT_MS = 3000;

// Each transaction counts with the gas it is sent with. A failed or slow
// estimate never blocks a review: after 3 s it opens without a total.
async function gasOf(
  deps: EarnFlowDeps,
  txs: EarnSendRequest[],
): Promise<EarnReviewGas | undefined> {
  const [first] = txs;
  if (!first) return undefined;
  const sameChain = txs.filter((tx) => tx.chainId === first.chainId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const estimates = deps.estimateGas
    ? await Promise.race([
        Promise.all(
          sameChain.map((tx) => deps.estimateGas!(tx).catch(() => null)),
        ),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), GAS_WAIT_MS);
        }),
      ]).finally(() => clearTimeout(timer))
    : undefined;
  const limits = sameChain.map((tx, i) =>
    sendGasLimit(estimates?.[i], tx.gasLimit),
  );
  return {
    chainId: first.chainId,
    tx: first,
    gasLimit: limits.every((limit) => limit !== undefined)
      ? limits.reduce((sum, limit) => sum + limit!, 0n)
      : undefined,
    count: sameChain.length,
  };
}

type StartResult = { strategy: EarnStrategy; vaultsUsed: number };

async function finishDeposit(
  deps: EarnFlowDeps,
  strategyId: string,
  vaultsUsed?: number,
): Promise<StartResult> {
  const strategy = await pollStrategy(
    deps,
    strategyId,
    (s) => s.status === 'active',
    'activation_timeout',
  );
  deps.deposits?.set(strategyId, null);
  deps.onStep?.({ kind: 'active', strategyId });
  return {
    strategy,
    vaultsUsed: vaultsUsed ?? strategy.positions?.length ?? 0,
  };
}

// A recorded hash means a deposit was already sent. Never send it twice.
async function settleRecordedDeposit(
  deps: EarnFlowDeps,
  strategyId: string,
): Promise<StartResult | null> {
  const recorded = deps.deposits?.get(strategyId);
  if (!recorded) return null;
  deps.onStep?.({ kind: 'confirming' });
  try {
    await deps.waitForReceipt(recorded, deps.chainId);
  } catch (e) {
    if (e instanceof EarnFlowError && e.code === 'tx_reverted') {
      deps.deposits?.set(strategyId, null);
      // Leave the wait screen: the deposit starts over with its sheets.
      deps.onStep?.({ kind: 'resuming' });
      return null;
    }
    throw new EarnFlowError(
      'deposit_pending',
      'An earlier deposit is not confirmed yet. Wait for it, then resume.',
    );
  }
  return finishDeposit(deps, strategyId);
}

async function loadGlobalHidden(
  api: EarnApi,
  address: string,
): Promise<Set<string>> {
  const prefs = await api.getPrefs(address);
  return new Set(
    (prefs.hidden_vault_keys ?? []).map((key) => key.toLowerCase()),
  );
}

// A saved hint can be stale: the server deletes an unfunded strategy after
// about an hour. Only a hint is dropped; an explicit resume fails.
async function loadResumable(
  api: EarnApi,
  strategyId: string,
  isHint: boolean,
  onStale?: () => void,
): Promise<EarnStrategy | null> {
  try {
    const existing = await api.getStrategy(strategyId);
    const usable =
      existing.status === 'pending_setup' || existing.status === 'active';
    if (isHint && !usable) {
      onStale?.();
      return null;
    }
    return existing;
  } catch (e) {
    if (isHint && e instanceof EarnApiError && e.code === 'not_found') {
      onStale?.();
      return null;
    }
    throw e;
  }
}

export async function startStrategy(
  {
    amountUsdc,
    settings,
    resumeStrategyId,
    resumeIsHint = false,
    onStrategyCreated,
    onStaleResume,
  }: {
    amountUsdc: number;
    settings: EarnSettings;
    resumeStrategyId?: string;
    resumeIsHint?: boolean;
    onStrategyCreated?: (strategyId: string) => void;
    onStaleResume?: () => void;
  },
  deps: EarnFlowDeps,
): Promise<StartResult> {
  const { api, address, chainId } = deps;
  const step = (s: EarnFlowStep) => deps.onStep?.(s);

  // A hint can turn out stale, and a new strategy then signs first.
  step({ kind: resumeStrategyId && !resumeIsHint ? 'resuming' : 'selecting' });
  let strategyId: string;
  // `selected` get the share approvals. `visible` may appear in the plan.
  let selected: EarnVault[];
  let visible: EarnVault[];
  // A resumed strategy deposits its own capital. It must match the form.
  let capitalUsdc = amountUsdc;

  const existing = resumeStrategyId
    ? await loadResumable(api, resumeStrategyId, resumeIsHint, onStaleResume)
    : null;

  if (existing) {
    if (existing.status === 'active') {
      step({ kind: 'active', strategyId: existing.id });
      return {
        strategy: existing,
        vaultsUsed: existing.positions?.length ?? 0,
      };
    }
    if (existing.status !== 'pending_setup') {
      throw new EarnFlowError(
        'invalid_state',
        `This strategy is ${existing.status}, so it cannot be funded.`,
      );
    }
    step({ kind: 'resuming' });
    const settled = await settleRecordedDeposit(deps, existing.id);
    if (settled) return settled;
    if (Math.abs(existing.capital_usdc - amountUsdc) > 1e-6) {
      throw new EarnFlowError(
        'amount_mismatch',
        `An unfinished deposit of ${existing.capital_usdc} USDC exists. Resume or cancel it first.`,
      );
    }
    capitalUsdc = existing.capital_usdc;
    const window =
      existing.apy_smoothing_minutes ?? settings.apySmoothingMinutes;
    const [vaults, globalHidden] = await Promise.all([
      api.listVaults(chainId, window),
      loadGlobalHidden(api, address),
    ]);
    const hiddenKeys = [...existing.hidden_vault_keys, ...globalHidden];
    visible = visibleVaultsOf(vaults, chainId, hiddenKeys);
    // The strategy's own floors decide, as they will at deposit time.
    selected = rankedVaults(
      visible,
      await api.rankVaults({
        chainId,
        capitalUsdc,
        maxPositions: existing.max_positions,
        minTvlUsd: existing.min_tvl_usd ?? settings.minTvlUsd,
        minLiquidityUsd: existing.min_liquidity_usd ?? settings.minLiquidityUsd,
        minLiquidityMultiplier: existing.min_liquidity_entry_multiplier,
        apySmoothingMinutes: window,
        hiddenKeys,
        wallet: address,
      }),
    );
    if (selected.length === 0) {
      throw new EarnFlowError('no_vaults', 'No vaults are open for deposits.');
    }
    strategyId = existing.id;
  } else {
    const minimum = minStrategyUsdc(await api.getConfig(), chainId);
    if (amountUsdc < minimum) {
      throw new EarnFlowError(
        'below_minimum',
        `The minimum deposit is ${minimum} USDC.`,
      );
    }
    const [allVaults, globalHidden] = await Promise.all([
      api.listVaults(chainId, settings.apySmoothingMinutes),
      loadGlobalHidden(api, address),
    ]);
    // The server merges the wallet's global hide list into every strategy.
    // Leave those vaults out of the pick, or its N + 1 count comes up short.
    const vaults = withoutHiddenVaults(allVaults, globalHidden);
    const pick = pickVisibleVaults(vaults, chainId, settings.vaultCount, {
      minTvlUsd: settings.minTvlUsd,
      minLiquidityUsd: settings.minLiquidityUsd,
    });
    visible = pick.visible;
    selected = rankedVaults(
      visible,
      await api.rankVaults({
        chainId,
        capitalUsdc: amountUsdc,
        maxPositions: settings.vaultCount,
        minTvlUsd: settings.minTvlUsd,
        minLiquidityUsd: settings.minLiquidityUsd,
        apySmoothingMinutes: settings.apySmoothingMinutes,
        hiddenKeys: [...pick.hiddenKeys, ...globalHidden],
        wallet: address,
      }),
    );
    if (selected.length === 0) {
      throw new EarnFlowError('no_vaults', 'No vaults are open for deposits.');
    }

    step({ kind: 'signing' });
    const body = await signWrite({
      action: 'strategy.create',
      payload: {
        name: EARN_STRATEGY_NAME,
        capital_usdc: amountUsdc,
        delta_pct: settings.deltaPct,
        delta_confirmations: settings.deltaConfirmations,
        max_positions: settings.vaultCount,
        min_tvl_usd: settings.minTvlUsd,
        min_liquidity_usd: settings.minLiquidityUsd,
        apy_smoothing_minutes: settings.apySmoothingMinutes,
        chain_id: chainId,
        chain_ids: [chainId],
        hidden_vault_keys: pick.hiddenKeys,
        idempotencyKey: crypto.randomUUID(),
      },
      domain: deps.siwe.domain,
      uri: deps.siwe.uri,
      chainId,
      path: '/strategies',
      address,
      // The user sees the exact message, and approves it, before it is signed.
      sign: async (message) =>
        signWithGrant(
          deps,
          message,
          await askUser(deps, {
            kind: 'sign_message',
            action: 'strategy.create',
            message,
            summary: {
              capitalUsdc: amountUsdc,
              vaults: selected.map((vault) => ({
                address: vault.vaultAddress,
                name: vault.name,
                apy: vault.apy,
              })),
            },
          }),
        ),
    });

    step({ kind: 'creating' });
    const created = await api.createStrategy(body);
    strategyId = created.id;
    onStrategyCreated?.(strategyId);
  }

  // Share approvals feed the vault ranking, so they must land before the
  // deposit calldata is requested.
  const approvalsRequest = {
    address,
    chainId,
    requiredUsdc: parseUnits(
      capitalUsdc.toFixed(USDC_DECIMALS),
      USDC_DECIMALS,
    ).toString(),
    vaultKeys: selected.map((vault) =>
      vaultKey(vault.chainId, vault.vaultAddress),
    ),
  };
  const approvals = await api.getApprovals(approvalsRequest);
  const missing = [approvals.usdc, ...approvals.vaults].filter(
    (
      entry,
    ): entry is EarnApprovalEntry & {
      tx: NonNullable<EarnApprovalEntry['tx']>;
    } => !!entry && !entry.approved && !!entry.tx,
  );
  if (missing.length > 0) {
    const spender = approvals.spender ?? '';
    const items = missing.map((entry) =>
      checkedApproval({
        token: entry.token,
        chainId,
        spender,
        tx: entry.tx,
        isUsdc: entry === approvals.usdc,
        label:
          entry === approvals.usdc
            ? 'USDC'
            : nameOfVault(visible, entry.vaultAddress ?? entry.token),
      }),
    );
    // Decided before the screen, so it states the true transaction count.
    const batched =
      missing.length > 1 && (await deps.canBatch?.(chainId)) === true;
    const txs = missing.map((entry) => sendRequestOf({ chainId, ...entry.tx }));
    const approvalsGrant = await askUser(deps, {
      kind: 'approvals',
      purpose: 'deposit',
      batched,
      spender,
      items,
      // A Smart Wallet batch prices its own gas, so it has no fee picker.
      gas: batched ? undefined : await gasOf(deps, txs),
    });
    if (batched) {
      step({
        kind: 'approving',
        index: 1,
        total: 1,
        items,
        purpose: 'deposit',
      });
      await sendBatchWithGrant(deps, txs, approvalsGrant);
      // The batch returns once sent. The allowances show when it is mined.
      await confirmApprovals(deps, approvalsRequest, 30);
    } else {
      for (const [i, tx] of txs.entries()) {
        step({
          kind: 'approving',
          index: i + 1,
          total: txs.length,
          items: [items[i]],
          purpose: 'deposit',
        });
        // One wallet transaction at a time keeps nonces in order.
        // eslint-disable-next-line no-await-in-loop
        await sendAndWait(deps, tx, approvalsGrant);
      }
      await confirmApprovals(deps, approvalsRequest);
    }
  }

  // The last approval stays the step until the deposit review opens.
  const deposit = await api.depositCalldata(strategyId);
  if (deposit.approvalsNeeded.length > 0) {
    throw new EarnFlowError(
      'approvals_incomplete',
      'Some approvals are still missing. Try again.',
    );
  }
  const allowed = new Set(
    visible.map((vault) => vault.vaultAddress.toLowerCase()),
  );
  const planVaults = deposit.plan.vaults.map((vault) => vault.toLowerCase());
  if (
    planVaults.length === 0 ||
    planVaults.some((vault) => !allowed.has(vault))
  ) {
    throw new EarnFlowError(
      'plan_mismatch',
      'The deposit plan does not match the chosen vaults. Nothing was sent.',
    );
  }
  const tx = deposit.transactions[0];
  if (!tx) {
    throw new EarnFlowError('no_transaction', 'The Earn API sent no deposit.');
  }
  checkDeposit({
    tx,
    plan: deposit.plan,
    amountUsdc: capitalUsdc,
    spender: approvals.spender ?? '',
  });
  const depositTx = sendRequestOf(tx);
  const depositGrant = await askUser(deps, {
    kind: 'deposit',
    amountUsdc: capitalUsdc,
    chainId: tx.chainId,
    to: tx.to,
    vaults: deposit.plan.vaults.map((address, i) => ({
      address,
      name: nameOfVault(visible, address) ?? address,
      amountUsdc: Number(
        formatUnits(BigInt(deposit.plan.amounts[i] ?? '0'), USDC_DECIMALS),
      ),
    })),
    gas: await gasOf(deps, [depositTx]),
  });
  step({ kind: 'depositing' });
  const hash = await sendWithGrant(deps, depositTx, depositGrant);
  // Record the hash before waiting, so a closed popup cannot cause a second deposit.
  deps.deposits?.set(strategyId, hash);
  step({ kind: 'confirming' });
  await deps.waitForReceipt(hash, tx.chainId);

  return finishDeposit(deps, strategyId, planVaults.length);
}

export async function withdrawStrategy(
  { strategyId }: { strategyId: string },
  deps: EarnFlowDeps,
): Promise<{ status: 'closed' | 'deleted'; strategy?: EarnStrategy }> {
  const { api } = deps;
  const step = (s: EarnFlowStep) => deps.onStep?.(s);

  step({ kind: 'preparing' });
  // The read only sets the review amount. A failed read must not stop a close.
  const [calldata, current] = await Promise.all([
    api.withdrawCalldata(strategyId),
    api.getStrategy(strategyId).catch(() => undefined),
  ]);

  if (calldata.fallback === 'delete') {
    // The API also offers this for a funded strategy whose positions are all
    // paused. Deleting it would leave the shares untracked.
    const { status } = current ?? (await api.getStrategy(strategyId));
    if (status !== 'pending_setup') {
      throw new EarnFlowError(
        'funded_close_blocked',
        'This strategy still holds positions that cannot be withdrawn here.',
      );
    }
    step({ kind: 'signing' });
    const body = await signWrite({
      action: 'strategy.delete',
      payload: {},
      domain: deps.siwe.domain,
      uri: deps.siwe.uri,
      chainId: deps.chainId,
      path: `/strategies/${strategyId}`,
      address: deps.address,
      sign: async (message) =>
        signWithGrant(
          deps,
          message,
          await askUser(deps, {
            kind: 'sign_message',
            action: 'strategy.delete',
            message,
          }),
        ),
    });
    await api.deleteStrategy(strategyId, body);
    step({ kind: 'closed' });
    return { status: 'deleted' };
  }

  await runWithdrawal(deps, calldata, {
    amountUsdc: current && closeValueUsdc(current),
  });

  step({ kind: 'confirming' });
  const strategy = await pollStrategy(
    deps,
    strategyId,
    (s) => s.status === 'closed',
    'close_timeout',
  );
  step({ kind: 'closed' });
  return { status: 'closed', strategy };
}

// The server leaves paused positions in their vaults. No net-value fallback:
// the net value also holds what stays behind.
function closeValueUsdc(strategy: EarnStrategy): number | undefined {
  const withdrawn = (strategy.positions ?? []).filter((p) => !p.paused);
  if (withdrawn.length === 0) return undefined;
  return withdrawn.reduce((sum, p) => sum + Number(p.usdc_value), 0);
}

// Each group stops at an approval sheet first.
async function runWithdrawal(
  deps: EarnFlowDeps,
  calldata: EarnWithdrawCalldata,
  review: Pick<
    Extract<EarnConfirmRequest, { kind: 'withdraw' }>,
    'partial' | 'amountUsdc'
  >,
): Promise<void> {
  const step = (s: EarnFlowStep) => deps.onStep?.(s);
  const approvals = calldata.approvalsNeeded ?? [];
  if (approvals.length > 0) {
    const spender = commonSpender(approvals.map((a) => a.spender));
    const items = approvals.map((approval) =>
      checkedApproval({
        token: approval.token,
        chainId: approval.chainId,
        spender,
        tx: approval.tx,
        isUsdc: false,
      }),
    );
    const txs = approvals.map((approval) =>
      sendRequestOf({ chainId: approval.chainId, ...approval.tx }),
    );
    const approvalsGrant = await askUser(deps, {
      kind: 'approvals',
      purpose: 'withdraw',
      spender,
      items,
      gas: await gasOf(deps, txs),
    });
    for (const [i, tx] of txs.entries()) {
      step({
        kind: 'approving',
        index: i + 1,
        total: txs.length,
        items: [items[i]],
        purpose: 'withdraw',
      });
      // eslint-disable-next-line no-await-in-loop
      await sendAndWait(deps, tx, approvalsGrant);
    }
  }

  if (calldata.transactions.length > 0) {
    const txs = calldata.transactions.map(sendRequestOf);
    const withdrawGrant = await askUser(deps, {
      kind: 'withdraw',
      ...review,
      gas: await gasOf(deps, txs),
      transactions: calldata.transactions.map((tx) => ({
        chainId: tx.chainId,
        to: tx.to,
        description: tx.description,
      })),
    });
    // The API orders transactions source chain first. Keep that order.
    for (const [i, tx] of txs.entries()) {
      step({
        kind: 'withdrawing',
        index: i + 1,
        total: txs.length,
      });
      // eslint-disable-next-line no-await-in-loop
      await sendAndWait(deps, tx, withdrawGrant);
    }
  }
}

// Runs after the approvals read agrees, so a few attempts are enough. Each call
// counts against the server's limit of 24 partial actions an hour.
async function freshTopUpCalldata(
  deps: EarnFlowDeps,
  strategyId: string,
  amountUsdc: number,
): Promise<EarnDepositCalldata> {
  const attempts = 3;
  const sleep = deps.sleep ?? defaultSleep;
  for (let i = 0; i < attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const calldata = await deps.api.depositCalldata(strategyId, { amountUsdc });
    if (calldata.approvalsNeeded.length === 0) return calldata;
    // eslint-disable-next-line no-await-in-loop
    if (i < attempts - 1) await sleep(APPROVAL_RECHECK_MS);
  }
  throw new EarnFlowError(
    'approvals_incomplete',
    'The approvals are not confirmed yet. Nothing was deposited. Try again.',
  );
}

const TOP_UP_MINIMUM_USDC = 10;

// The server funds only the vaults the strategy already holds, so the plan
// must stay inside them.
export async function topUpStrategy(
  { strategy, amountUsdc }: { strategy: EarnStrategy; amountUsdc: number },
  deps: EarnFlowDeps,
): Promise<EarnStrategy | undefined> {
  const { api } = deps;
  const step = (s: EarnFlowStep) => deps.onStep?.(s);
  if (!Number.isFinite(amountUsdc) || amountUsdc < TOP_UP_MINIMUM_USDC) {
    throw new EarnFlowError(
      'below_minimum',
      `The minimum increase is ${TOP_UP_MINIMUM_USDC} USDC.`,
    );
  }
  if (strategy.status !== 'active') {
    throw new EarnFlowError(
      'invalid_state',
      `This strategy is ${strategy.status}, so it cannot take more funds.`,
    );
  }
  const positions = strategy.positions ?? [];
  const nameOfHeld = (address: string) =>
    positions.find(
      (p) => p.vault_address.toLowerCase() === address.toLowerCase(),
    )?.vault_name;

  step({ kind: 'preparing' });
  const first = await api.depositCalldata(strategy.id, { amountUsdc });
  const needed = first.approvalsNeeded;
  const spender =
    needed.length > 0 ? commonSpender(needed.map((a) => a.spender)) : undefined;
  const isUsdcToken = (token: string) =>
    token.toLowerCase() === USDC_BASE_ADDRESS.toLowerCase();

  if (spender !== undefined) {
    const items = needed.map((approval) => {
      const isUsdc = isUsdcToken(approval.token);
      return checkedApproval({
        token: approval.token,
        chainId: approval.chainId,
        spender,
        tx: approval.tx,
        isUsdc,
        label: isUsdc ? 'USDC' : nameOfHeld(approval.token),
      });
    });
    const txs = needed.map((approval) =>
      sendRequestOf({ chainId: approval.chainId, ...approval.tx }),
    );
    const approvalsGrant = await askUser(deps, {
      kind: 'approvals',
      purpose: 'deposit',
      spender,
      items,
      gas: await gasOf(deps, txs),
    });
    for (const [i, tx] of txs.entries()) {
      step({
        kind: 'approving',
        index: i + 1,
        total: txs.length,
        items: [items[i]],
        purpose: 'deposit',
      });
      // eslint-disable-next-line no-await-in-loop
      await sendAndWait(deps, tx, approvalsGrant);
    }
  }

  // The server RPC can lag a block. Wait on the approvals read first.
  let calldata = first;
  if (spender !== undefined) {
    const usdcNeeded = needed.find((a) => isUsdcToken(a.token));
    await confirmApprovals(deps, {
      address: deps.address,
      chainId: needed[0].chainId,
      requiredUsdc: usdcNeeded?.requiredAllowance ?? '0',
      vaultKeys: needed
        .filter((a) => a !== usdcNeeded)
        .map((a) => vaultKey(a.chainId, a.token)),
    });
    calldata = await freshTopUpCalldata(deps, strategy.id, amountUsdc);
  }

  const held = new Set(positions.map((p) => p.vault_address.toLowerCase()));
  const planVaults = calldata.plan.vaults.map((v) => v.toLowerCase());
  if (planVaults.length === 0 || planVaults.some((v) => !held.has(v))) {
    throw new EarnFlowError(
      'plan_mismatch',
      'The deposit plan uses a vault your strategy does not hold. Nothing was sent.',
    );
  }
  const tx = calldata.transactions[0];
  if (!tx) {
    throw new EarnFlowError('no_transaction', 'The Earn API sent no deposit.');
  }
  // Without approvals there is no spender yet. One approvals read names it.
  const contract =
    spender ??
    (
      await api.getApprovals({
        address: deps.address,
        chainId: tx.chainId,
        requiredUsdc: '0',
        vaultKeys: [],
      })
    ).spender ??
    '';
  checkDeposit({ tx, plan: calldata.plan, amountUsdc, spender: contract });
  const depositTx = sendRequestOf(tx);
  const depositGrant = await askUser(deps, {
    kind: 'deposit',
    amountUsdc,
    chainId: tx.chainId,
    to: tx.to,
    vaults: calldata.plan.vaults.map((address, i) => ({
      address,
      name: nameOfHeld(address) ?? address,
      amountUsdc: Number(
        formatUnits(BigInt(calldata.plan.amounts[i] ?? '0'), USDC_DECIMALS),
      ),
    })),
    gas: await gasOf(deps, [depositTx]),
  });
  step({ kind: 'depositing' });
  const hash = await sendWithGrant(deps, depositTx, depositGrant);
  step({ kind: 'confirming' });
  await deps.waitForReceipt(hash, tx.chainId);
  const fresh = await waitForNewValue(
    deps,
    strategy.id,
    strategy.net_value_usdc,
    amountUsdc,
    ledgerOf(strategy),
  );
  step({ kind: 'done' });
  return fresh;
}

// Never signs a delete: a funded strategy must not be deleted from here.
export async function partialWithdraw(
  {
    strategyId,
    amountUsdc,
    valueBeforeUsdc,
  }: { strategyId: string; amountUsdc: number; valueBeforeUsdc?: number },
  deps: EarnFlowDeps,
): Promise<EarnStrategy | undefined> {
  const step = (s: EarnFlowStep) => deps.onStep?.(s);
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    throw new EarnFlowError('invalid_amount', 'Enter an amount above zero.');
  }
  step({ kind: 'preparing' });
  const calldata = await deps.api.withdrawCalldata(strategyId, { amountUsdc });
  if (calldata.fallback === 'delete' || calldata.transactions.length === 0) {
    throw new EarnFlowError(
      'nothing_to_withdraw',
      'The Earn service plans no withdrawal for this amount.',
    );
  }
  // Without the server's fee quote the sheet would show guesses.
  if (!calldata.partial) {
    throw new EarnFlowError(
      'no_quote',
      'The Earn service sent no fee quote. Nothing was sent.',
    );
  }
  await runWithdrawal(deps, calldata, {
    partial: {
      amountUsdc,
      feeUsdc: calldata.partial.feeUsdc,
      receiveUsdc: calldata.partial.receiveUsdc,
    },
  });
  step({ kind: 'confirming' });
  const fresh = await waitForNewValue(
    deps,
    strategyId,
    valueBeforeUsdc,
    -amountUsdc,
  );
  step({ kind: 'done' });
  return fresh;
}

export type StrategyPatch = Partial<{
  delta_pct: number;
  delta_confirmations: number;
  min_tvl_usd: number;
  min_liquidity_usd: number;
  apy_smoothing_minutes: number;
}>;

// The server rejects a delta under 0.25. The other bounds keep nonsense out of
// a signed request.
function validatePatch(patch: StrategyPatch) {
  const bad =
    Object.keys(patch).length === 0 ||
    (patch.delta_pct !== undefined && !(patch.delta_pct >= 0.25)) ||
    (patch.delta_confirmations !== undefined &&
      !(
        Number.isInteger(patch.delta_confirmations) &&
        patch.delta_confirmations >= 1
      )) ||
    (patch.min_tvl_usd !== undefined && !(patch.min_tvl_usd >= 0)) ||
    (patch.min_liquidity_usd !== undefined &&
      !(patch.min_liquidity_usd >= 0)) ||
    (patch.apy_smoothing_minutes !== undefined &&
      !(
        Number.isInteger(patch.apy_smoothing_minutes) &&
        patch.apy_smoothing_minutes >= 5 &&
        patch.apy_smoothing_minutes <= 1440
      ));
  if (bad) {
    throw new EarnFlowError(
      'invalid_settings',
      'One of the settings is out of range. Nothing was signed.',
    );
  }
}

// One signed message: it costs no gas and moves no funds.
export async function updateStrategySettings(
  {
    strategyId,
    patch,
    before,
  }: { strategyId: string; patch: StrategyPatch; before?: StrategyPatch },
  deps: EarnFlowDeps,
): Promise<EarnStrategy> {
  validatePatch(patch);
  deps.onStep?.({ kind: 'signing' });
  const body = await signWrite({
    action: 'strategy.update',
    payload: patch,
    domain: deps.siwe.domain,
    uri: deps.siwe.uri,
    chainId: deps.chainId,
    path: `/strategies/${strategyId}`,
    address: deps.address,
    sign: async (message) =>
      signWithGrant(
        deps,
        message,
        await askUser(deps, {
          kind: 'sign_message',
          action: 'strategy.update',
          message,
          changes: (Object.keys(patch) as (keyof StrategyPatch)[]).map(
            (field) => ({
              field,
              from: before?.[field],
              to: patch[field] as number,
            }),
          ),
        }),
      ),
  });
  deps.onStep?.({ kind: 'saving' });
  const updated = await deps.api.updateStrategy(strategyId, body);
  deps.onStep?.({ kind: 'done' });
  return updated;
}
