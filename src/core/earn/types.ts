import type { Address, Hex } from 'viem';

export type EarnEnvironmentName = 'production' | 'staging';

export type EarnEnvironment = {
  baseUrl: string;
  apiKey: string;
  siweDomain: string;
};

export type EarnConfig = {
  chains: Array<{ chainId: number; name: string; minStrategyUsdc: number }>;
};

export type EarnPrefs = {
  address?: string;
  hidden_vault_keys: string[];
};

export type EarnVault = {
  chainId: number;
  vaultAddress: string;
  name: string;
  apy: number | null;
  tvlUsd: number;
  availableLiquidityUsd: number | null;
  maxDepositUsd: number | null;
  atCapacity: boolean;
};

export type EarnTxRequest = {
  to: string;
  data: string;
  value: string;
};

export type EarnTx = EarnTxRequest & {
  chainId: number;
  intentId?: string;
  kind?: string;
  description?: string;
  gasHint?: string | null;
};

export type EarnApprovalEntry = {
  token: string;
  vaultAddress?: string;
  currentAllowance: string;
  requiredAllowance: string;
  approved: boolean;
  tx?: EarnTxRequest;
};

export type EarnChainApprovals = {
  chainId: number;
  spender: string | null;
  usdc: EarnApprovalEntry | null;
  vaults: EarnApprovalEntry[];
  error: string | null;
};

export type EarnApprovalNeeded = {
  chainId: number;
  token: string;
  spender: string;
  currentAllowance: string;
  requiredAllowance: string;
  tx: EarnTxRequest;
};

export type EarnDepositPlan = {
  vaults: string[];
  amounts: string[];
  totalUsdc: string;
  vaultNames?: Record<string, string>;
  apys?: Record<string, number>;
};

export type EarnDepositCalldata = {
  transactions: EarnTx[];
  approvalsNeeded: EarnApprovalNeeded[];
  plan: EarnDepositPlan;
  expiresAt: string;
};

export type EarnWithdrawCalldata = {
  transactions: EarnTx[];
  approvalsNeeded?: EarnApprovalNeeded[];
  fallback?: 'delete';
  // Present on a partial withdrawal.
  partial?: { feeUsdc: number; receiveUsdc: number };
};

export type EarnWithdrawQuote = {
  kind: 'withdraw_quote';
  netValueUsdc: number;
  floorUsdc: number;
  maxWithdrawUsdc: number;
  minActionUsdc: number;
  feeEstimateUsdc: number;
  fullCloseOnly: boolean;
};

export type EarnPosition = {
  id: string;
  vault_name: string;
  vault_address: string;
  chain_id: number;
  usdc_value: number;
  entry_apy: number;
  initial_usd_value?: number | null;
  paused?: boolean;
};

export type EarnStrategyStatus =
  | 'pending_setup'
  | 'active'
  | 'closing'
  | 'closed'
  | string;

export type EarnStrategy = {
  id: string;
  wallet_address: string;
  name: string;
  capital_usdc: number;
  status: EarnStrategyStatus;
  chain_id: number;
  hidden_vault_keys: string[];
  max_positions: number;
  delta_pct?: number;
  delta_confirmations?: number;
  min_tvl_usd?: number;
  min_liquidity_usd?: number;
  min_liquidity_entry_multiplier?: number;
  apy_smoothing_minutes?: number;
  total_value_usdc?: number;
  net_value_usdc?: number;
  realized_apy?: number | null;
  positions?: EarnPosition[];
  created_at?: string;
  first_deposit_at?: string | null;
  // Set on a closed strategy: when it closed, and what it was worth then.
  deactivated_at?: string | null;
  final_value_usdc?: number | null;
  // Lifetime totals. Earned = net value + withdrawn - contributed.
  contributed_usdc?: number;
  withdrawn_usdc?: number;
};

export type EarnSettings = {
  environment: EarnEnvironmentName;
  chainId: number;
  vaultCount: number;
  deltaPct: number;
  deltaConfirmations: number;
  minTvlUsd: number;
  minLiquidityUsd: number;
  apySmoothingMinutes: number;
};

export type SiweBody<T extends Record<string, unknown>> = T & {
  siwe: { message: string; signature: Hex };
};

export type EarnWalletAddress = Address;
