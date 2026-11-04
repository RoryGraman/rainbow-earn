import { useEffect, useRef } from 'react';

import { i18n } from '~/core/languages';
import { useCurrentAddressStore } from '~/core/state';
import { answerConfirmation } from '~/core/state/earn/confirm';
import { countdownJob, useEarnRunStore, waitCopy } from '~/core/state/earn/run';
import {
  Box,
  ButtonSymbol,
  Inline,
  Stack,
  Symbol,
  Text,
} from '~/design-system';
import { useContainerRef } from '~/design-system/components/AnimatedRoute/AnimatedRoute';
import { AccentColorProvider } from '~/design-system/components/Box/ColorContext';

import { Spinner } from '../../../components/Spinner/Spinner';

import { EarnAmountSheet } from './EarnAmountSheet';
import { EarnConfirmSheet } from './EarnConfirmSheet';
import { EarnDeposit } from './EarnDeposit';
import {
  EARN_ACCENT,
  EarnCard,
  EarnCountdown,
  EarnStepper,
  PoweredBy,
} from './EarnParts';
import { EarnPosition } from './EarnPosition';
import { EarnSettingsSheet } from './EarnSettingsSheet';
import { copyText, stepLabel } from './earnFormat';
import { useEarnStrategy } from './useEarnData';
import { useEarnRunner } from './useEarnRunner';

// The settings button on the right of the navbar, styled like the X on the
// left. An open strategy has its own settings row.
export function EarnSettingsAction() {
  const { currentAddress } = useCurrentAddressStore();
  const { strategy } = useEarnStrategy(currentAddress);
  const openSettings = useEarnRunStore((s) => s.openSettings);
  if (strategy && strategy.status !== 'pending_setup') return null;
  return (
    <ButtonSymbol
      color="surfaceSecondaryElevated"
      symbolColor="labelSecondary"
      variant="flat"
      height="32px"
      symbol="gearshape.fill"
      symbolSize={14}
      onClick={() => openSettings(null)}
      testId="earn-settings-button"
    />
  );
}

// The Earn page with its sheets. Leaving the page declines an open review and
// closes the other sheets. Reviews asked for while it is closed are declined
// too (see `confirm.ts`), so no request waits out of sight.
export function EarnPage() {
  useEffect(() => {
    const runState = useEarnRunStore.getState();
    runState.setPageOpen(true);
    return () => {
      runState.setPageOpen(false);
      answerConfirmation(false);
      runState.setAmountSheet(null);
      runState.setSettingsOpen(false);
    };
  }, []);
  // An open review belongs to the wallet it was asked for. A switch closes it.
  const { currentAddress } = useCurrentAddressStore();
  useEffect(() => () => answerConfirmation(false), [currentAddress]);
  return (
    <>
      <Earn />
      <EarnSettingsSheet />
      <EarnAmountSheet />
      <EarnConfirmSheet />
    </>
  );
}

export function Earn() {
  const { currentAddress } = useCurrentAddressStore();
  const { strategy, data: strategyList } = useEarnStrategy(currentAddress);
  const runner = useEarnRunner(currentAddress);

  // Any open strategy except an unfunded one: active, closing, paused.
  const funded = strategy && strategy.status !== 'pending_setup';
  const pending = strategy?.status === 'pending_setup' ? strategy : null;
  const waitStartedAt = useEarnRunStore((s) => s.waitStartedAt);
  const job = useEarnRunStore((s) => s.job);
  // A full-page countdown for each transaction, until the chain and the Earn
  // service catch up. An approval or a withdrawal starts its ring just before
  // the send. A deposit starts its ring after the send.
  const wait = useEarnRunStore(countdownJob);
  const waitStep = useEarnRunStore((s) => s.waitStep);
  const copy = wait && waitStep ? waitCopy(waitStep, wait) : null;
  // An open review shows the stepper in its own sheet.
  const reviewOpen = useEarnRunStore((s) => s.confirmation !== null);

  // The countdown and the screen after it each open at the top.
  const containerRef = useContainerRef();
  const lastWait = useRef(wait);
  useEffect(() => {
    if (lastWait.current === wait) return;
    lastWait.current = wait;
    containerRef.current?.scrollTo({ top: 0 });
  }, [wait, containerRef]);

  return (
    <AccentColorProvider color={EARN_ACCENT}>
      <Box paddingHorizontal="20px" paddingTop="8px" paddingBottom="24px">
        <Stack space="20px">
          {!reviewOpen && <EarnStepper />}
          {runner.step && !wait && (
            <EarnCard>
              <Box testId="earn-progress">
                <Stack space="10px">
                  <Inline alignVertical="center" space="8px">
                    <Spinner size={14} color="accent" />
                    <Text size="14pt" weight="semibold" color="label">
                      {stepLabel(runner.step, job)}
                    </Text>
                  </Inline>
                  <Text size="12pt" weight="medium" color="labelTertiary">
                    {i18n.t('earn.keep_open')}
                  </Text>
                </Stack>
              </Box>
            </EarnCard>
          )}

          {runner.error && (
            <EarnCard>
              <Box testId="earn-error">
                <Stack space="10px">
                  <Inline alignVertical="center" space="8px">
                    <Symbol
                      symbol="exclamationmark.triangle.fill"
                      size={14}
                      weight="bold"
                      color="red"
                    />
                    <Text size="14pt" weight="semibold" color="red">
                      {i18n.t('earn.error_title')}
                    </Text>
                  </Inline>
                  <Text size="12pt" weight="medium" color="labelSecondary">
                    {runner.error}
                  </Text>
                </Stack>
              </Box>
            </EarnCard>
          )}

          {copy && waitStartedAt !== null && (
            <EarnCountdown
              startedAt={waitStartedAt}
              seconds={9}
              title={copyText(copy.title)}
              body={copyText(copy.body)}
              next={copyText(copy.next)}
              overtime={
                copy.overtime && {
                  title: copyText(copy.overtime.title),
                  body: copyText(copy.overtime.body),
                }
              }
              detail={runner.step ? stepLabel(runner.step, job) : undefined}
            />
          )}
          {!wait && funded && (
            <EarnPosition
              strategy={strategy}
              list={strategyList}
              runner={runner}
            />
          )}
          {!wait && !funded && (
            <EarnDeposit
              address={currentAddress}
              pending={pending}
              runner={runner}
            />
          )}

          {!funded && !wait && <PoweredBy />}
        </Stack>
      </Box>
    </AccentColorProvider>
  );
}
