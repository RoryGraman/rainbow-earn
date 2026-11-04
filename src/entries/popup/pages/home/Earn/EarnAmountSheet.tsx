import { useState } from 'react';

import { amountProblem, parseAmount } from '~/core/earn/amounts';
import { minStrategyUsdc } from '~/core/earn/config';
import { displayFeeUsd } from '~/core/earn/fees';
import { i18n } from '~/core/languages';
import { useCurrentAddressStore } from '~/core/state';
import { useEarnStore } from '~/core/state/earn';
import {
  type EarnAmountSheetState,
  useEarnRunStore,
} from '~/core/state/earn/run';
import { Box, Separator, Stack, Text } from '~/design-system';
import { AccentColorProvider } from '~/design-system/components/Box/ColorContext';

import { Navbar } from '../../../components/Navbar/Navbar';

import {
  AmountCard,
  EARN_ACCENT,
  EarnCard,
  InfoLine,
  PrimaryButton,
  chainName,
} from './EarnParts';
import { EarnSheet } from './EarnSheet';
import { formatUsd } from './earnFormat';
import {
  useEarnConfig,
  useEarnStrategy,
  useUsdcBalance,
  useWithdrawQuote,
} from './useEarnData';
import { useEarnRunner } from './useEarnRunner';

const TOP_UP_MINIMUM = 10;

function AmountForm({
  sheet,
  onClose,
}: {
  sheet: EarnAmountSheetState;
  onClose: () => void;
}) {
  const { currentAddress } = useCurrentAddressStore();
  const chainId = useEarnStore((s) => s.settings.chainId);
  const runner = useEarnRunner(currentAddress);
  const increase = sheet.mode === 'increase';
  const [text, setText] = useState('');

  const balance = useUsdcBalance(currentAddress, chainId, increase).data;
  const quoteQuery = useWithdrawQuote(sheet.strategy.id, !increase);
  const quote = quoteQuery.data;

  const { data: config } = useEarnConfig();
  const keepInvested = minStrategyUsdc(config, chainId);
  // Read live: a position can pause while the sheet is open.
  const { strategy: live } = useEarnStrategy(currentAddress);
  const hasPaused = (live?.positions ?? sheet.strategy.positions ?? []).some(
    (p) => p.paused,
  );

  const amount = parseAmount(text);
  const limits = increase
    ? { min: TOP_UP_MINIMUM, max: balance }
    : { min: quote?.minActionUsdc ?? 0, max: quote?.maxWithdrawUsdc };
  const ready = increase ? balance !== undefined : !!quote;
  const fullCloseOnly = !increase && !!quote?.fullCloseOnly;
  const problem = amountProblem(amount, limits);
  const canContinue = ready && !fullCloseOnly && problem === null;
  // A withdrawal that would leave less than the strategy minimum is a close.
  // Offer that instead. With paused positions the close needs the warning on
  // the main screen first.
  const closeInstead =
    !increase && ready && (fullCloseOnly || problem === 'too_high');

  const hint = (() => {
    if (!ready) {
      return quoteQuery.isError
        ? i18n.t('earn.amount_quote_error')
        : i18n.t('earn.amount_loading');
    }
    if (fullCloseOnly) return i18n.t('earn.amount_full_close_only');
    if (text === '' || problem === null || problem === 'empty') return null;
    if (problem === 'too_low') {
      return i18n.t('earn.amount_too_low', { amount: formatUsd(limits.min) });
    }
    if (increase) return i18n.t('earn.amount_too_high_increase');
    return i18n.t(
      hasPaused
        ? 'earn.amount_too_high_decrease_paused'
        : 'earn.amount_too_high_decrease',
      { amount: formatUsd(keepInvested) },
    );
  })();

  const closeStrategy = () => {
    onClose();
    runner.withdraw(sheet.strategy.id);
  };

  const confirm = () => {
    if (!canContinue) return;
    onClose();
    // The live value is the baseline the wait compares against.
    const strategy = live?.id === sheet.strategy.id ? live : sheet.strategy;
    if (increase) runner.topUp(strategy, amount);
    else runner.decrease(strategy, amount);
  };

  return (
    <Stack space="16px">
      <Text size="12pt" weight="medium" color="labelSecondary">
        {increase
          ? i18n.t('earn.amount_note_increase')
          : i18n.t('earn.amount_note_decrease')}
      </Text>

      <AmountCard
        value={text}
        onChange={setText}
        available={(() => {
          if (increase) {
            return balance === undefined
              ? null
              : `${i18n.t('earn.balance')}: ${formatUsd(balance)}`;
          }
          return quote
            ? `${i18n.t('earn.amount_position')}: ${formatUsd(
                quote.netValueUsdc,
              )}`
            : null;
        })()}
        onMax={
          increase && balance !== undefined
            ? () => setText(String(Math.floor(balance * 100) / 100))
            : undefined
        }
        hint={hint}
        testId="earn-amount-sheet-input"
      />

      <EarnCard>
        <Stack space="16px">
          {increase && (
            <InfoLine
              symbol="dollarsign.square"
              label={i18n.t('earn.amount_minimum')}
              value={formatUsd(TOP_UP_MINIMUM)}
            />
          )}
          {!increase && quote && (
            <>
              <InfoLine
                symbol="chart.line.uptrend.xyaxis"
                label={i18n.t('earn.amount_value')}
                value={formatUsd(quote.netValueUsdc)}
              />
              <InfoLine
                symbol="lock.fill"
                label={i18n.t('earn.amount_keep_invested')}
                value={formatUsd(keepInvested)}
              />
              <InfoLine
                symbol="dollarsign.square"
                label={i18n.t('earn.amount_minimum')}
                value={formatUsd(quote.minActionUsdc)}
              />
              {/* The server's figure is the bridge fee withheld from the
                  amount. The gas shows on the review. */}
              {quote.feeEstimateUsdc > 0 && (
                <InfoLine
                  symbol="fuelpump.fill"
                  label={i18n.t('earn.confirm_partial_fee')}
                  value={displayFeeUsd(quote.feeEstimateUsdc)}
                />
              )}
            </>
          )}
          <InfoLine
            symbol="point.3.filled.connected.trianglepath.dotted"
            label={i18n.t('earn.info_network')}
            value={chainName(chainId)}
          />
        </Stack>
      </EarnCard>

      {!increase && quote && (
        <Text size="12pt" weight="medium" color="labelTertiary">
          {i18n.t('earn.amount_close_note', {
            amount: formatUsd(keepInvested),
          })}
        </Text>
      )}

      {closeInstead && !hasPaused ? (
        <PrimaryButton
          label={i18n.t('earn.amount_close_instead')}
          enabled
          onClick={closeStrategy}
          testId="earn-amount-close-instead"
        />
      ) : (
        <PrimaryButton
          label={i18n.t('earn.amount_continue')}
          enabled={canContinue}
          onClick={confirm}
          testId="earn-amount-continue"
        />
      )}
    </Stack>
  );
}

// Rendered once by the Earn page, like the other Earn sheets. It only
// collects an amount. Nothing is signed here: Continue starts the flow, and the
// flow stops at an approval sheet before every signature.
export function EarnAmountSheet() {
  const sheet = useEarnRunStore((s) => s.amountSheet);
  const setAmountSheet = useEarnRunStore((s) => s.setAmountSheet);
  const close = () => setAmountSheet(null);

  return (
    <EarnSheet show={sheet !== null} onClickOutside={close}>
      <AccentColorProvider color={EARN_ACCENT}>
        <Navbar
          title={
            sheet?.mode === 'decrease'
              ? i18n.t('earn.decrease')
              : i18n.t('earn.increase')
          }
          leftComponent={
            <Navbar.CloseButton testId="earn-amount" onClick={close} />
          }
        />
        <Separator color="separatorTertiary" />
        {sheet && (
          <Box padding="20px">
            <AmountForm
              key={`${sheet.mode}-${sheet.strategy.id}`}
              sheet={sheet}
              onClose={close}
            />
          </Box>
        )}
      </AccentColorProvider>
    </EarnSheet>
  );
}
