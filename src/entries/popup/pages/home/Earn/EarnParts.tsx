import { Fragment, type ReactNode, useEffect, useState } from 'react';

import { i18n } from '~/core/languages';
import { stepperOf, useEarnRunStore } from '~/core/state/earn/run';
import { ChainId } from '~/core/types/chains';
import { getChain } from '~/core/utils/chains';
import {
  Box,
  Button,
  Inline,
  Symbol,
  Text,
  TextOverflow,
} from '~/design-system';
import { Input } from '~/design-system/components/Input/Input';
import {
  accentColorAsHsl,
  transparentAccentColorAsHsl,
} from '~/design-system/styles/core.css';
import type {
  SymbolName,
  TextColor,
} from '~/design-system/styles/designTokens';

import { ChainBadge } from '../../../components/ChainBadge/ChainBadge';
import { Spinner } from '../../../components/Spinner/Spinner';

import { sanitizeAmount } from './earnFormat';

// USDC blue. The Earn page takes it as its accent, the way a token page takes
// the token's colour.
export const EARN_ACCENT = '#2775CA';

// Circle's USDC mark. Inline, because remote token icons need Rainbow's keys.
function UsdcLogo({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 2000 2000"
      role="img"
      aria-label="USDC"
    >
      <path
        fill="#2775CA"
        d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z"
      />
      <path
        fill="#fff"
        d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z"
      />
      <path
        fill="#fff"
        d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z"
      />
    </svg>
  );
}

export function EarnCoin({
  size = 40,
  badge = false,
}: {
  size?: number;
  badge?: boolean;
}) {
  return (
    <Box
      position="relative"
      style={{ width: size, height: size }}
      testId="earn-coin"
    >
      <Box
        borderRadius="round"
        style={{
          width: size,
          height: size,
          boxShadow: `0 4px 12px ${EARN_ACCENT}55`,
        }}
      >
        <UsdcLogo size={size} />
      </Box>
      {badge && (
        <Box position="absolute" style={{ bottom: -2, left: -6 }}>
          <ChainBadge chainId={ChainId.base} size="16" shadow />
        </Box>
      )}
    </Box>
  );
}

// Rainbow's InfoRow, with an optional colour for the value.
export function InfoLine({
  symbol,
  label,
  value,
  valueColor = 'labelSecondary',
  testId,
}: {
  symbol: SymbolName;
  label: ReactNode;
  value: ReactNode;
  valueColor?: TextColor;
  testId?: string;
}) {
  return (
    <Box
      display="flex"
      alignItems="center"
      justifyContent="space-between"
      gap="8px"
    >
      <Box
        display="flex"
        alignItems="center"
        gap="12px"
        style={{ flex: 1, minWidth: 0 }}
      >
        <Symbol
          size={14}
          symbol={symbol}
          weight="medium"
          color="labelTertiary"
        />
        <TextOverflow color="labelTertiary" size="12pt" weight="semibold">
          {label}
        </TextOverflow>
      </Box>
      <Box style={{ flexShrink: 0 }}>
        <Text
          color={valueColor}
          size="12pt"
          weight="semibold"
          whiteSpace="nowrap"
          testId={testId}
        >
          {value}
        </Text>
      </Box>
    </Box>
  );
}

export function EarnCard({ children }: { children: ReactNode }) {
  return (
    <Box
      background="surfaceSecondaryElevated"
      borderRadius="16px"
      boxShadow="12px"
      padding="16px"
    >
      {children}
    </Box>
  );
}

// The amount card from Rainbow's swap screen: coin, large amount, token pill,
// then balance and Max underneath.
export function AmountCard({
  value,
  onChange,
  available,
  onMax,
  disabled,
  hint,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  available: string | null;
  onMax?: () => void;
  disabled?: boolean;
  hint?: string | null;
  testId: string;
}) {
  return (
    <Box
      background="surfaceSecondaryElevated"
      borderRadius="24px"
      borderColor="separatorTertiary"
      borderWidth="1px"
      boxShadow="12px"
      padding="16px"
    >
      <Box display="flex" flexDirection="column" gap="12px">
        <Box display="flex" alignItems="center" gap="12px">
          <EarnCoin size={36} badge />
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Input
              variant="transparent"
              height="40px"
              fontSize="23pt"
              style={{ paddingLeft: 0, paddingRight: 0 }}
              placeholder="0"
              value={value}
              onChange={(e) => onChange(sanitizeAmount(e.target.value))}
              disabled={disabled}
              testId={testId}
            />
          </Box>
          <Box
            background="fillSecondary"
            borderRadius="round"
            paddingHorizontal="10px"
            paddingVertical="6px"
          >
            <Text size="14pt" weight="heavy" color="label">
              USDC
            </Text>
          </Box>
        </Box>
        <Box
          display="flex"
          alignItems="center"
          justifyContent="space-between"
          gap="8px"
        >
          <Text size="12pt" weight="semibold" color="labelTertiary">
            {available ?? ' '}
          </Text>
          {onMax && (
            <Box onClick={onMax} style={{ cursor: 'pointer' }}>
              <Inline alignVertical="center" space="4px" wrap={false}>
                <Symbol
                  symbol="sparkle"
                  size={12}
                  weight="heavy"
                  color="accent"
                />
                <Text size="12pt" weight="heavy" color="accent">
                  {i18n.t('earn.max')}
                </Text>
              </Inline>
            </Box>
          )}
        </Box>
        {hint && (
          <Text
            size="12pt"
            weight="medium"
            color="red"
            testId="earn-amount-hint"
          >
            {hint}
          </Text>
        )}
      </Box>
    </Box>
  );
}

// The full-width primary action used across Rainbow's request screens.
// `busy` replaces the label with a spinner and the current step.
export function PrimaryButton({
  label,
  enabled,
  onClick,
  testId,
  busy,
}: {
  label: string;
  enabled: boolean;
  onClick: () => void;
  testId: string;
  busy?: string | null;
}) {
  const active = enabled && !busy;
  return (
    <Button
      height="44px"
      variant="flat"
      color={active ? 'accent' : 'fillSecondary'}
      width="full"
      disabled={!active}
      onClick={onClick}
      testId={testId}
    >
      {busy ? (
        <Box
          display="flex"
          alignItems="center"
          gap="8px"
          style={{ minWidth: 0 }}
        >
          <Spinner size={14} color="labelSecondary" />
          <TextOverflow size="16pt" weight="bold" color="labelSecondary">
            {busy}
          </TextOverflow>
        </Box>
      ) : (
        <TextOverflow
          size="16pt"
          weight="bold"
          color={active ? 'label' : 'labelQuaternary'}
        >
          {label}
        </TextOverflow>
      )}
    </Button>
  );
}

export function PoweredBy() {
  return (
    <Box style={{ opacity: 0.6 }} paddingTop="4px">
      <Text align="center" size="12pt" weight="medium" color="labelTertiary">
        {i18n.t('earn.powered_by')}
      </Text>
    </Box>
  );
}

// A full-page wait, so the page never shows a half-filled screen.
export function EarnLoading({ title, body }: { title: string; body?: string }) {
  return (
    <Box
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap="16px"
      style={{ minHeight: 360 }}
      testId="earn-loading"
    >
      <Spinner size={32} color="accent" />
      <Text align="center" size="16pt" weight="heavy" color="label">
        {title}
      </Text>
      {body && (
        <Box style={{ maxWidth: 260 }}>
          <Text
            align="center"
            size="12pt"
            weight="medium"
            color="labelTertiary"
          >
            {body}
          </Text>
        </Box>
      )}
    </Box>
  );
}

const RING = 30;
const RING_LENGTH = 2 * Math.PI * RING;

// The wait after a signature: a ring that empties as the expected seconds
// pass, then a spinner if the chain or the Earn service needs longer. The
// screen always moves, so the wallet never looks frozen.
export function EarnCountdown({
  startedAt,
  seconds,
  title,
  body,
  next,
  overtime: overtimeText,
  detail,
}: {
  startedAt: number;
  seconds: number;
  title: string;
  body: string;
  // What the user does or sees after this wait.
  next?: string;
  // The words once the ring runs out. Without them, the words stay.
  overtime?: { title: string; body: string };
  detail?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  // A new wait can start between two ticks, so its time left starts full.
  const left = Math.min(
    seconds,
    Math.max(0, seconds - (now - startedAt) / 1000),
  );
  const overtime = left === 0;

  return (
    <Box
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap="16px"
      style={{ minHeight: 360 }}
      testId="earn-countdown"
    >
      <Box
        position="relative"
        display="flex"
        alignItems="center"
        justifyContent="center"
        style={{ width: 72, height: 72 }}
      >
        {overtime ? (
          <Spinner size={32} color="accent" />
        ) : (
          <>
            <svg
              width={72}
              height={72}
              viewBox="0 0 72 72"
              style={{ position: 'absolute', inset: 0 }}
            >
              <circle
                cx={36}
                cy={36}
                r={RING}
                fill="none"
                stroke={transparentAccentColorAsHsl}
                strokeWidth={5}
              />
              <circle
                cx={36}
                cy={36}
                r={RING}
                fill="none"
                stroke={accentColorAsHsl}
                strokeWidth={5}
                strokeLinecap="round"
                strokeDasharray={RING_LENGTH}
                strokeDashoffset={RING_LENGTH * (1 - left / seconds)}
                transform="rotate(-90 36 36)"
                style={{ transition: 'stroke-dashoffset 0.25s linear' }}
              />
            </svg>
            <Text size="20pt" weight="heavy" color="label">
              {Math.ceil(left)}
            </Text>
          </>
        )}
      </Box>
      <Text align="center" size="16pt" weight="heavy" color="label">
        {overtime && overtimeText ? overtimeText.title : title}
      </Text>
      <Box style={{ maxWidth: 260 }}>
        <Text align="center" size="12pt" weight="medium" color="labelTertiary">
          {overtime && overtimeText ? overtimeText.body : body}
        </Text>
      </Box>
      {next && (
        <Box
          background="surfaceSecondaryElevated"
          borderRadius="round"
          paddingHorizontal="12px"
          paddingVertical="8px"
          testId="earn-countdown-next"
        >
          <Text align="center" size="12pt" weight="semibold" color="label">
            {next}
          </Text>
        </Box>
      )}
      {detail && (
        <Text align="center" size="12pt" weight="semibold" color="accent">
          {detail}
        </Text>
      )}
    </Box>
  );
}

// Where the user is in a job with several steps: done, now, and later.
export function EarnStepper() {
  const job = useEarnRunStore((s) => s.job);
  const jobApprovals = useEarnRunStore((s) => s.jobApprovals);
  const step = useEarnRunStore((s) => s.step);
  const confirmation = useEarnRunStore((s) => s.confirmation);
  const stepper = stepperOf({ job, jobApprovals, step, confirmation });
  if (!stepper) return null;
  const { phases, current } = stepper;
  return (
    <Box
      display="flex"
      alignItems="center"
      justifyContent="center"
      gap="6px"
      testId="earn-stepper"
    >
      {phases.map((phase, i) => {
        const state = i < current ? 'done' : i === current ? 'now' : 'later';
        const label =
          job === 'topup' && phase === 'deposit' ? 'increase' : phase;
        return (
          <Fragment key={phase}>
            {i > 0 && (
              <Symbol
                symbol="chevron.right"
                size={8}
                weight="bold"
                color="labelQuaternary"
              />
            )}
            <Box
              display="flex"
              alignItems="center"
              gap="4px"
              testId={`earn-stepper-${state}`}
            >
              <Symbol
                symbol={
                  state === 'done'
                    ? 'checkmark.circle.fill'
                    : state === 'now'
                    ? 'circle.fill'
                    : 'circle'
                }
                size={10}
                weight="bold"
                color={state === 'later' ? 'labelQuaternary' : 'accent'}
              />
              <Text
                size="12pt"
                weight={state === 'now' ? 'bold' : 'semibold'}
                color={
                  state === 'now'
                    ? 'label'
                    : state === 'done'
                    ? 'labelSecondary'
                    : 'labelTertiary'
                }
              >
                {i18n.t(`earn.phase_${label}`)}
              </Text>
            </Box>
          </Fragment>
        );
      })}
    </Box>
  );
}

// Rainbow's getChain falls back to Ethereum for an unknown id. Name the id.
export const chainName = (chainId: number) => {
  const chain = getChain({ chainId });
  return chain.id === chainId ? chain.name : `Chain ${chainId}`;
};
