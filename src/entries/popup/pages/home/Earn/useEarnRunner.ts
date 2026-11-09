import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { Address } from 'viem';

import {
  EarnFlowDeps,
  EarnFlowError,
  StrategyPatch,
  partialWithdraw,
  startStrategy,
  topUpStrategy,
  updateStrategySettings,
  withdrawStrategy,
} from '~/core/earn/flow';
import type { EarnStrategy } from '~/core/earn/types';
import { i18n } from '~/core/languages';
import { pendingKey, useEarnStore } from '~/core/state/earn';
import {
  type EarnJob,
  countdownJob,
  useEarnRunStore,
} from '~/core/state/earn/run';
import { logger } from '~/logger';

import { triggerToast } from '../../../components/Toast/Toast';

import { errorMessage, formatUsd } from './earnFormat';
import { createEarnDeps } from './earnWallet';

type EarnToast = Parameters<typeof triggerToast>[0];

// The run state lives in a store outside React, so leaving the Earn page
// cannot drop it or start a second run.
export function useEarnRunner(address: Address) {
  const queryClient = useQueryClient();
  const step = useEarnRunStore((s) => s.step);
  const error = useEarnRunStore((s) => s.error);
  const running = useEarnRunStore((s) => s.running);

  const run = useCallback(
    async (
      name: EarnJob,
      job: (deps: EarnFlowDeps) => Promise<EarnToast | void>,
    ) => {
      const runState = useEarnRunStore.getState();
      if (runState.running) return;
      runState.setRunning(true);
      runState.setJob(name);
      runState.setError(null);
      let toast: EarnToast | void = undefined;
      try {
        const settings = useEarnStore.getState().settings;
        toast = await job(
          createEarnDeps({ address, settings, onStep: runState.setStep }),
        );
      } catch (e) {
        runState.setStep(null);
        // A decline is the user's own choice, not a failure to report.
        if (!(e instanceof EarnFlowError && e.code === 'user_declined')) {
          logger.error(e instanceof Error ? e : new Error(String(e)));
          runState.setError(errorMessage(e));
        }
      } finally {
        // A countdown holds until the new figures are in. Other runs end now.
        if (!countdownJob(useEarnRunStore.getState())) runState.setStep(null);
        // refetchQueries also reaches the position queries, unmounted during
        // the wait.
        await Promise.all(
          ['strategies', 'performance', 'performance-series'].map((key) =>
            queryClient.refetchQueries({ queryKey: ['earn', key] }),
          ),
        );
        runState.setStep(null);
        runState.setJob(null);
        runState.setRunning(false);
        queryClient.invalidateQueries({ queryKey: ['earn'] });
        // Shown when the countdown ends, so the user sees what changed.
        if (toast) triggerToast(toast);
      }
    },
    [address, queryClient],
  );

  const start = useCallback(
    (amountUsdc: number, resumeStrategyId?: string) =>
      run('start', async (deps) => {
        const earn = useEarnStore.getState();
        const key = pendingKey(earn.settings.environment, address);
        // Only a hint: the flow drops it when the server no longer has it.
        const hint = resumeStrategyId ? undefined : earn.pendingStrategies[key];
        try {
          const result = await startStrategy(
            {
              amountUsdc,
              settings: earn.settings,
              resumeStrategyId: resumeStrategyId ?? hint,
              resumeIsHint: !!hint,
              onStrategyCreated: (id) => earn.setPendingStrategy(key, id),
              onStaleResume: () => earn.setPendingStrategy(key, null),
            },
            deps,
          );
          earn.setPendingStrategy(key, null);
          useEarnRunStore.getState().setSettled({
            id: result.strategy.id,
            wallet: address.toLowerCase(),
            strategy: result.strategy,
          });
        } catch (e) {
          if (e instanceof EarnFlowError && e.code === 'invalid_state') {
            earn.setPendingStrategy(key, null);
          }
          throw e;
        }
      }),
    [run, address],
  );

  const withdraw = useCallback(
    (strategyId: string) =>
      run('close', async (deps) => {
        const result = await withdrawStrategy({ strategyId }, deps);
        const earn = useEarnStore.getState();
        earn.setPendingStrategy(
          pendingKey(earn.settings.environment, address),
          null,
        );
        earn.setSentDeposit(strategyId, null);
        useEarnRunStore.getState().setSettled({
          id: strategyId,
          wallet: address.toLowerCase(),
          strategy: result.status === 'closed' ? result.strategy ?? null : null,
        });
        return result.status === 'closed'
          ? {
              title: i18n.t('earn.toast_closed_title'),
              description: i18n.t('earn.toast_closed_body'),
            }
          : { title: i18n.t('earn.toast_deleted_title') };
      }),
    [run, address],
  );

  // The list endpoint is cached for a few seconds. The fresh strategy shows
  // until the list agrees.
  const settle = useCallback(
    (strategy: EarnStrategy) =>
      useEarnRunStore.getState().setSettled({
        id: strategy.id,
        wallet: address.toLowerCase(),
        strategy,
      }),
    [address],
  );

  const topUp = useCallback(
    (strategy: EarnStrategy, amountUsdc: number) =>
      run('topup', async (deps) => {
        const fresh = await topUpStrategy({ strategy, amountUsdc }, deps);
        if (fresh) settle(fresh);
        return {
          title: i18n.t('earn.toast_increase_title', {
            amount: formatUsd(amountUsdc),
          }),
        };
      }),
    [run, settle],
  );

  const decrease = useCallback(
    (strategy: EarnStrategy, amountUsdc: number) =>
      run('decrease', async (deps) => {
        const fresh = await partialWithdraw(
          {
            strategyId: strategy.id,
            amountUsdc,
            valueBeforeUsdc: strategy.net_value_usdc,
          },
          deps,
        );
        if (fresh) settle(fresh);
        return {
          title: i18n.t('earn.toast_decrease_title', {
            amount: formatUsd(amountUsdc),
          }),
          description: i18n.t('earn.toast_decrease_body'),
        };
      }),
    [run, settle],
  );

  const saveSettings = useCallback(
    (strategyId: string, patch: StrategyPatch, before: StrategyPatch) =>
      run('settings', async (deps) => {
        await updateStrategySettings({ strategyId, patch, before }, deps);
      }),
    [run],
  );

  return {
    step,
    error,
    running,
    start,
    withdraw,
    topUp,
    decrease,
    saveSettings,
  };
}
