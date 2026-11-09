import { useState } from 'react';
import type { Address } from 'viem';

import { minStrategyUsdc } from '~/core/earn/config';
import { EARN_TERMS_URL } from '~/core/earn/defaults';
import type { EarnStrategy } from '~/core/earn/types';
import { repeatedNameDetails } from '~/core/earn/vaults';
import { i18n } from '~/core/languages';
import { useEarnStore } from '~/core/state/earn';
import { useEarnRunStore } from '~/core/state/earn/run';
import { goToNewTab } from '~/core/utils/tabs';
import {
  Box,
  Button,
  Inline,
  Stack,
  Text,
  TextOverflow,
} from '~/design-system';

import { useDebounce } from '../../../hooks/useDebounce';
import { colors as avatarColors } from '../../../utils/emojiAvatarBackgroundColors';
import { pseudoRandomArrayItemFromString } from '../../../utils/pseudoRandomArrayItemFromString';

import {
  AmountCard,
  EARN_ACCENT,
  EarnCard,
  EarnCoin,
  InfoLine,
  PrimaryButton,
  chainName,
} from './EarnParts';
import {
  formatCompactUsd,
  formatPercent,
  formatUsd,
  stepLabel,
} from './earnFormat';
import { useEarnConfig, useTopVaults, useUsdcBalance } from './useEarnData';
import { useEarnRunner } from './useEarnRunner';

function Hero({ apy }: { apy: number | null }) {
  return (
    <Box
      display="flex"
      flexDirection="column"
      alignItems="center"
      paddingTop="8px"
    >
      <Box
        position="relative"
        display="flex"
        alignItems="center"
        justifyContent="center"
        paddingBottom="16px"
      >
        <Box
          position="absolute"
          style={{
            width: 120,
            height: 120,
            borderRadius: '50%',
            background: EARN_ACCENT,
            filter: 'blur(48px)',
            opacity: 0.45,
          }}
        />
        <EarnCoin size={56} />
      </Box>
      <Box paddingBottom="12px" style={{ opacity: 0.6 }}>
        <Text align="center" size="12pt" weight="heavy" color="labelSecondary">
          {i18n.t('earn.hero_kicker')}
        </Text>
      </Box>
      {apy === null ? (
        <Text align="center" size="20pt" weight="heavy" color="label">
          {i18n.t('earn.deposit_title')}
        </Text>
      ) : (
        <Stack space="10px" alignHorizontal="center">
          <Text
            align="center"
            size="32pt"
            weight="heavy"
            color="green"
            textShadow="12px green"
            testId="earn-hero-apy"
          >
            {`${formatPercent(apy)}%`}
          </Text>
          <Text
            align="center"
            size="14pt"
            weight="heavy"
            color="labelSecondary"
          >
            {i18n.t('earn.hero_apy_label')}
          </Text>
        </Stack>
      )}
    </Box>
  );
}

// `detail` is the short address, for a name another row also has.
function VaultRow({
  address,
  name,
  detail,
  tvlUsd,
  apy,
}: {
  address: string;
  name: string;
  detail: string | null;
  tvlUsd: number;
  apy: number | null;
}) {
  return (
    <Box
      display="flex"
      alignItems="center"
      gap="12px"
      testId={`earn-vault-${address.toLowerCase()}`}
    >
      <Box
        display="flex"
        alignItems="center"
        justifyContent="center"
        borderRadius="round"
        style={{
          width: 36,
          height: 36,
          flexShrink: 0,
          background: pseudoRandomArrayItemFromString(name, avatarColors),
        }}
      >
        <Text size="14pt" weight="heavy" color="label">
          <span style={{ color: '#fff' }}>{name.charAt(0)}</span>
        </Text>
      </Box>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Stack space="8px">
          <TextOverflow size="14pt" weight="semibold" color="label">
            {name}
          </TextOverflow>
          <Text size="12pt" weight="semibold" color="labelTertiary">
            {i18n.t('earn.tvl', { value: formatCompactUsd(tvlUsd) })}
            {detail && ` · ${detail}`}
          </Text>
        </Stack>
      </Box>
      <Stack space="8px" alignHorizontal="right">
        <Text size="14pt" weight="semibold" color="green">
          {apy === null ? '--' : `${formatPercent(apy)}%`}
        </Text>
        <Text size="12pt" weight="semibold" color="labelTertiary">
          {i18n.t('earn.estimated_apy')}
        </Text>
      </Stack>
    </Box>
  );
}

export function EarnDeposit({
  address,
  pending,
  runner,
}: {
  address: Address;
  pending: EarnStrategy | null;
  runner: ReturnType<typeof useEarnRunner>;
}) {
  const chainId = useEarnStore((s) => s.settings.chainId);
  const vaultCount = useEarnStore((s) => s.settings.vaultCount);
  const job = useEarnRunStore((s) => s.job);
  const { data: balance } = useUsdcBalance(address, chainId);

  const [amount, setAmount] = useState('');

  // A sent deposit has left the wallet, so the balance check does not apply.
  const depositSent = useEarnStore(
    (s) => !!pending && !!s.sentDeposits[pending.id],
  );

  const { data: config } = useEarnConfig();
  const minimum = minStrategyUsdc(config, chainId);
  // Ranked for the amount, as the flow will be, once typing pauses.
  const typed = Number(amount);
  const rankAmount =
    Number.isFinite(typed) && typed > minimum ? typed : minimum;
  const rankFor = useDebounce(rankAmount, 400);
  const {
    data: picked,
    isLoading: vaultsLoading,
    isError: vaultsError,
    isPlaceholderData,
  } = useTopVaults(address, pending, rankFor);
  // The list on screen must be loaded and ranked for this amount.
  const listCurrent =
    !!picked?.selected.length && rankFor === rankAmount && !isPlaceholderData;

  const parsed = pending ? pending.capital_usdc : Number(amount);
  const hasAmount = Number.isFinite(parsed) && parsed > 0;
  const enough = depositSent || balance === undefined || parsed <= balance;
  // A pending strategy already has its capital, so the minimum was met.
  const aboveMinimum = !!pending || parsed >= minimum;
  // A sent deposit only needs the wait, which does not use the list.
  const canStart =
    hasAmount &&
    enough &&
    aboveMinimum &&
    (depositSent || listCurrent) &&
    !runner.running;

  // The deposit is split evenly, so the estimate is the plain average.
  const selected = picked?.selected ?? [];
  const nameDetails = repeatedNameDetails(
    selected.map((v) => ({ name: v.name, address: v.vaultAddress })),
  );
  const apys = selected
    .map((v) => v.apy)
    .filter((apy): apy is number => apy !== null);
  const estimatedApy = apys.length
    ? apys.reduce((sum, apy) => sum + apy, 0) / apys.length
    : null;

  const busy =
    runner.running && job === 'start'
      ? runner.step
        ? stepLabel(runner.step, job)
        : i18n.t('earn.step_waiting')
      : null;

  const label = (() => {
    if (!enough) return i18n.t('earn.cta_not_enough');
    if (pending) return i18n.t('earn.cta_resume');
    if (!hasAmount) return i18n.t('earn.cta_enter_amount');
    if (!aboveMinimum) {
      return i18n.t('earn.cta_below_minimum', { amount: formatUsd(minimum) });
    }
    return i18n.t('earn.cta_start');
  })();

  return (
    <Stack space="16px">
      <Hero apy={estimatedApy} />

      {pending ? (
        <EarnCard>
          <Stack space="10px">
            <Text size="14pt" weight="semibold" color="label">
              {i18n.t('earn.pending_title')}
            </Text>
            <Text size="12pt" weight="medium" color="labelTertiary">
              {i18n.t('earn.pending_body', {
                amount: formatUsd(pending.capital_usdc),
              })}
            </Text>
          </Stack>
        </EarnCard>
      ) : (
        <AmountCard
          value={amount}
          onChange={setAmount}
          available={
            balance === undefined
              ? null
              : `${i18n.t('earn.balance')}: ${formatUsd(balance)}`
          }
          onMax={
            balance === undefined ? undefined : () => setAmount(String(balance))
          }
          disabled={runner.running}
          testId="earn-amount-input"
        />
      )}

      <Stack space="12px">
        <PrimaryButton
          label={label}
          enabled={canStart}
          busy={busy}
          onClick={() => runner.start(parsed, pending?.id)}
          testId="earn-start-button"
        />
        {pending && !depositSent && (
          <Button
            height="44px"
            variant="flat"
            color="separatorSecondary"
            width="full"
            disabled={runner.running}
            onClick={() => runner.withdraw(pending.id)}
            testId="earn-cancel-pending-button"
          >
            {i18n.t('earn.cta_cancel_pending')}
          </Button>
        )}
        <Text
          align="center"
          size="12pt"
          weight="medium"
          color="labelQuaternary"
        >
          {i18n.t('earn.deposit_body')}
        </Text>
        <Inline alignHorizontal="center" space="4px">
          <Text size="12pt" weight="medium" color="labelTertiary">
            {i18n.t('earn.terms')}
          </Text>
          <Box
            onClick={() => goToNewTab({ url: EARN_TERMS_URL })}
            style={{ cursor: 'pointer' }}
          >
            <Text size="12pt" weight="semibold" color="accent">
              {i18n.t('earn.terms_link')}
            </Text>
          </Box>
        </Inline>
      </Stack>
      <EarnCard>
        <Stack space="16px">
          <InfoLine
            symbol="percent"
            label={i18n.t('earn.estimated_apy')}
            value={
              estimatedApy === null ? '--' : `${formatPercent(estimatedApy)}%`
            }
            valueColor="green"
          />
          <InfoLine
            symbol="square.stack.3d.up"
            label={i18n.t('earn.info_vaults')}
            value={i18n.t('earn.info_vaults_value', {
              count: picked?.count ?? vaultCount,
            })}
          />
          {!pending && (
            <InfoLine
              symbol="dollarsign.square"
              label={i18n.t('earn.amount_minimum')}
              value={formatUsd(minimum)}
            />
          )}
          <InfoLine
            symbol="point.3.filled.connected.trianglepath.dotted"
            label={i18n.t('earn.info_network')}
            value={chainName(chainId)}
          />
        </Stack>
      </EarnCard>

      <Stack space="16px">
        <Text size="14pt" weight="semibold" color="labelTertiary">
          {i18n.t('earn.vaults_title', { count: picked?.count ?? vaultCount })}
        </Text>
        {vaultsLoading && (
          <Text size="12pt" weight="medium" color="labelTertiary">
            {i18n.t('earn.vaults_loading')}
          </Text>
        )}
        {picked && selected.length === 0 && (
          <Text size="12pt" weight="medium" color="labelTertiary">
            {i18n.t('earn.vaults_empty')}
          </Text>
        )}
        {!picked && vaultsError && (
          <Text size="12pt" weight="medium" color="labelTertiary">
            {i18n.t('earn.vaults_error')}
          </Text>
        )}
        {selected.map((vault, i) => (
          <VaultRow
            key={vault.vaultAddress}
            address={vault.vaultAddress}
            name={vault.name}
            detail={nameDetails[i]}
            tvlUsd={vault.tvlUsd}
            apy={vault.apy}
          />
        ))}
      </Stack>
    </Stack>
  );
}
