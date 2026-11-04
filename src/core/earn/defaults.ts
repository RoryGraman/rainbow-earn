import type {
  EarnEnvironment,
  EarnEnvironmentName,
  EarnSettings,
} from './types';

export const BASE_CHAIN_ID = 8453;
export const USDC_DECIMALS = 6;
// Used only when /v1/config does not list the chain. Base asks for $500.
export const DEFAULT_MIN_STRATEGY_USDC = 500;
export const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const EARN_TERMS_URL = 'https://www.quicknode.com/terms-of-service';
// Every strategy this wallet creates has this name. The chart's history
// counts only these, not strategies made in the Earn web app.
export const EARN_STRATEGY_NAME = 'Rainbow Earn';

// Publishable keys are public by design (see the Earn API guide).
export const EARN_ENVIRONMENTS: Record<EarnEnvironmentName, EarnEnvironment> = {
  production: {
    baseUrl: 'https://earn-api.quicknode.dev/functions/v1/api',
    apiKey: 'sb_publishable_3xcdKa_uMRhK71Izd6BLdg_2vskXZ_h',
    siweDomain: 'earn-api.quicknode.dev',
  },
  staging: {
    baseUrl: 'https://ruiihfemzcvvrztjbevi.supabase.co/functions/v1/api',
    apiKey: 'sb_publishable_Uo5MmvRcubf0Fcn6mnfoCw_5_-1MPdd',
    siweDomain: 'ruiihfemzcvvrztjbevi.supabase.co',
  },
};

export const DEFAULT_EARN_SETTINGS: EarnSettings = {
  environment: 'production',
  chainId: BASE_CHAIN_ID,
  vaultCount: 5,
  deltaPct: 3,
  deltaConfirmations: 12,
  minTvlUsd: 1_000_000,
  minLiquidityUsd: 0,
  apySmoothingMinutes: 360,
};
