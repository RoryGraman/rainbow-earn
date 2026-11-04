import type { EarnFlowStep } from '~/core/earn/flow';
import { i18n } from '~/core/languages';
import { type EarnCopy, type EarnJob, stepKey } from '~/core/state/earn/run';

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const compactUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

export const formatUsd = (value: number) => usd.format(value);
export const copyText = ({ key, count, vault, amountUsdc }: EarnCopy) =>
  i18n.t(`earn.${key}`, {
    count,
    vault,
    amount: amountUsdc === undefined ? undefined : formatUsd(amountUsdc),
  });
// Keeps digits and one dot, with at most six decimals (USDC has six).
export const sanitizeAmount = (raw: string) => {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const [whole, ...rest] = cleaned.split('.');
  return rest.length ? `${whole}.${rest.join('').slice(0, 6)}` : whole;
};
// +$1.23 or -$0.50, so a gain and a loss read at a glance.
export const formatSignedUsd = (value: number) =>
  `${value < 0 ? '-' : '+'}${usd.format(Math.abs(value))}`;
export const formatCompactUsd = (value: number) => compactUsd.format(value);
export const formatPercent = (value: number | null | undefined) =>
  value === null || value === undefined ? '--' : value.toFixed(2);

export function stepLabel(step: EarnFlowStep, job: EarnJob | null): string {
  const key = `earn.${stepKey(step.kind, job)}`;
  switch (step.kind) {
    case 'approving':
    case 'withdrawing':
      return i18n.t(key, { index: step.index, total: step.total });
    case 'active':
    case 'closed':
      return i18n.t('earn.step_done');
    default:
      return i18n.t(key);
  }
}

// Flow and API errors carry a code. A known code maps to a translated
// message. Anything else shows its own text, cut before the long JSON that
// wallet and RPC errors append after a "[" marker.
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const fallback = raw.split('[')[0].trim() || i18n.t('earn.error_unknown');
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    return i18n.t(`earn.error_${code}`, { defaultValue: fallback });
  }
  return fallback;
}
