import { useMemo, useRef, useState } from 'react';

import {
  type ChartEntry,
  type StrategyList,
  chartStrategies,
  chartWindows,
  combinedValueChartData,
  currentYield,
  historyStart,
  strategyApy,
} from '~/core/earn/strategies';
import type { EarnStrategy } from '~/core/earn/types';
import { i18n } from '~/core/languages';
import { useEarnStore } from '~/core/state/earn';
import { useEarnRunStore } from '~/core/state/earn/run';
import { ChainId } from '~/core/types/chains';
import { POPUP_DIMENSIONS } from '~/core/utils/dimensions';
import {
  Box,
  Button,
  Separator,
  Symbol,
  Text,
  TextOverflow,
} from '~/design-system';
import type { TextColor } from '~/design-system/styles/designTokens';

import { ChainBadge } from '../../../components/ChainBadge/ChainBadge';
import { Menu } from '../../../components/Menu/Menu';
import { MenuItem } from '../../../components/Menu/MenuItem';

import { EarnCoin, EarnLoading } from './EarnParts';
import { EarnValueChart } from './EarnValueChart';
import { formatPercent, formatSignedUsd, formatUsd } from './earnFormat';
import {
  useClosedSeries,
  useLatestPerformance,
  usePerformanceSeries,
} from './useEarnData';
import { useEarnRunner } from './useEarnRunner';

const WINDOW_LABELS: Record<number, string> = {
  24: 'token_details.day',
  168: 'token_details.week',
  720: 'token_details.month',
  2160: 'earn.window_3m',
};
const HOUR = 3_600_000;

function statusOf(strategy: EarnStrategy, pausedCount: number) {
  if (strategy.status === 'closing') {
    return { label: i18n.t('earn.status_closing'), color: 'orange' as const };
  }
  if (pausedCount > 0) {
    return { label: i18n.t('earn.status_paused'), color: 'orange' as const };
  }
  return { label: i18n.t('earn.status_active'), color: 'green' as const };
}

function Column({
  label,
  value,
  color,
  align = 'left',
  testId,
}: {
  label: string;
  value: string;
  color: TextColor;
  align?: 'left' | 'right';
  testId?: string;
}) {
  return (
    <Box
      display="flex"
      flexDirection="column"
      gap="12px"
      alignItems={align === 'right' ? 'flex-end' : 'flex-start'}
    >
      <Text size="12pt" weight="semibold" color="labelTertiary">
        {label}
      </Text>
      <Text size="14pt" weight="semibold" color={color} testId={testId}>
        {value}
      </Text>
    </Box>
  );
}

// The screen of an open strategy, laid out like a Rainbow token page.
export function EarnPosition({
  strategy,
  list,
  runner,
}: {
  strategy: EarnStrategy;
  // Every strategy of the wallet. The chart also shows the closed ones.
  list?: StrategyList;
  runner: ReturnType<typeof useEarnRunner>;
}) {
  const chainId = useEarnStore((s) => s.settings.chainId);
  const setAmountSheet = useEarnRunStore((s) => s.setAmountSheet);
  const openSettings = useEarnRunStore((s) => s.openSettings);
  const { data: latest, isFetched: latestFetched } = useLatestPerformance(
    strategy.id,
  );
  const closing = strategy.status === 'closing';
  const active = strategy.status === 'active';
  const value = strategy.net_value_usdc ?? strategy.total_value_usdc ?? 0;

  // The chart's history starts at the first strategy this wallet opened.
  const startedAt = historyStart(
    chartStrategies(list, strategy, chainId, -Infinity),
  );
  const windows = chartWindows(
    startedAt === undefined ? null : (Date.now() - startedAt) / HOUR,
  );
  const [picked, setPicked] = useState<number | null>(null);
  const hours =
    picked !== null && windows.shown.includes(picked)
      ? picked
      : windows.initial;
  // A closed strategy whose close is older than the range adds nothing.
  const charted = useMemo(
    () => chartStrategies(list, strategy, chainId, Date.now() - hours * HOUR),
    [list, strategy, chainId, hours],
  );
  const {
    data: series,
    isFetched: seriesFetched,
    isError: seriesFailed,
    isPlaceholderData,
  } = usePerformanceSeries(strategy.id, hours);
  const closedIds = useMemo(
    () => charted.filter((s) => s.id !== strategy.id).map((s) => s.id),
    [charted, strategy.id],
  );
  const {
    data: closedSeries,
    isFetched: closedFetched,
    isPlaceholderData: closedPlaceholder,
  } = useClosedSeries(closedIds, hours);
  // Snapshots carry the vault value without bridges in flight, so the right
  // edge uses the same figure.
  const chartValue = strategy.total_value_usdc ?? value;
  const computed = useMemo(() => {
    const to = Date.now();
    const entries: ChartEntry[] = charted.map((s) => {
      const snapshots = s.id === strategy.id ? series : closedSeries?.[s.id];
      const opened = Date.parse(s.first_deposit_at ?? s.created_at ?? '');
      const startedAtOf = Number.isFinite(opened) ? opened : undefined;
      if (s.id === strategy.id) {
        return { snapshots, startedAt: startedAtOf, currentValue: chartValue };
      }
      // A closed strategy ends at its close, worth its final value.
      const closedAt = Date.parse(s.deactivated_at ?? '');
      const last = snapshots?.[snapshots.length - 1]?.total_value_usdc;
      return {
        snapshots,
        startedAt: startedAtOf,
        endedAt: Number.isFinite(closedAt) ? closedAt : undefined,
        // A Postgres numeric can arrive as a string.
        currentValue: Number(s.final_value_usdc ?? last ?? 0) || 0,
      };
    });
    return {
      hours,
      data: combinedValueChartData(entries, {
        from: to - hours * HOUR,
        to,
        buckets: 120,
      }),
    };
  }, [charted, series, closedSeries, hours, strategy.id, chartValue]);
  // On a range switch the old series stays until the new one loads. Keep the
  // old chart on its own axis, not the old data on the new axis.
  const lastChart = useRef(computed);
  // With no closed strategy in range, the closed query is off and its
  // placeholder flag never clears.
  if (!isPlaceholderData && !(closedIds.length > 0 && closedPlaceholder)) {
    lastChart.current = computed;
  }
  const chart = lastChart.current;
  const earned = currentYield(strategy, latest);
  const apy = strategyApy(strategy, latest);
  const idle = !runner.running;
  const canAdjust = active && idle;
  const canClose = !closing && idle;

  // The server leaves paused positions out of a withdrawal. Ask once before
  // the user closes with some of them still in the vaults.
  const pausedCount = (strategy.positions ?? []).filter((p) => p.paused).length;
  const [confirmPaused, setConfirmPaused] = useState(false);
  const onClose = () => {
    if (pausedCount > 0 && !confirmPaused) {
      setConfirmPaused(true);
      return;
    }
    runner.withdraw(strategy.id);
  };

  const earnedColor: TextColor =
    earned === null || earned === 0 ? 'label' : earned > 0 ? 'green' : 'red';
  const status = statusOf(strategy, pausedCount);

  // Show the screen only when every figure and the chart can fill at once.
  // A range switch keeps the previous series, so it does not come back here.
  const ready =
    latestFetched &&
    (series !== undefined || seriesFetched) &&
    (closedIds.length === 0 || closedSeries !== undefined || closedFetched);
  if (!ready) {
    return <EarnLoading title={i18n.t('earn.loading_position_title')} />;
  }

  return (
    <Box display="flex" flexDirection="column" gap="16px">
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="center"
        gap="10px"
      >
        <Box display="flex" alignItems="center" gap="10px">
          <EarnCoin size={40} />
          <Box display="flex" flexDirection="column" gap="10px">
            <Text size="16pt" weight="heavy" color="label" testId="earn-value">
              {formatUsd(value)}
            </Text>
            <TextOverflow size="14pt" weight="heavy" color="accent">
              {i18n.t('earn.position_name')}
            </TextOverflow>
          </Box>
        </Box>
        <Box
          display="flex"
          flexDirection="column"
          gap="10px"
          alignItems="flex-end"
        >
          <Text size="16pt" weight="heavy" color="green" testId="earn-apy">
            {apy === null ? '--' : `${formatPercent(apy)}%`}
          </Text>
          <Text size="14pt" weight="heavy" color="green">
            {i18n.t('earn.estimated_apy')}
          </Text>
        </Box>
      </Box>

      {series === undefined && seriesFailed ? (
        <Box
          display="flex"
          alignItems="center"
          justifyContent="center"
          style={{ height: 170 }}
        >
          <Text size="12pt" weight="semibold" color="labelTertiary">
            {i18n.t('earn.chart_unavailable')}
          </Text>
        </Box>
      ) : (
        <Box marginHorizontal="-20px">
          <EarnValueChart
            data={chart.data}
            width={POPUP_DIMENSIONS.width}
            height={170}
            hours={chart.hours}
          />
        </Box>
      )}
      <Box display="flex" justifyContent="center" gap="12px">
        {windows.shown.map((h) => (
          <Button
            key={h}
            onClick={() => setPicked(h)}
            height="24px"
            variant={h === hours ? 'tinted' : 'transparentHover'}
            color={h === hours ? 'accent' : 'labelTertiary'}
          >
            {i18n.t(WINDOW_LABELS[h])}
          </Button>
        ))}
      </Box>

      <Separator color="separatorTertiary" />

      <Box display="flex" justifyContent="space-between" gap="10px">
        <Column
          label={i18n.t('earn.current_yield')}
          value={earned === null ? '--' : formatSignedUsd(earned)}
          color={earnedColor}
          testId="earn-yield"
        />
        <Column
          label={i18n.t('earn.status')}
          value={status.label}
          color={status.color}
          align="right"
        />
      </Box>

      <Box display="flex" gap="8px">
        <Button
          height="32px"
          variant="flat"
          width="full"
          color="accent"
          symbol="plus.circle"
          disabled={!canAdjust}
          onClick={() => setAmountSheet({ mode: 'increase', strategy })}
          testId="earn-increase-button"
        >
          {i18n.t('earn.increase_short')}
        </Button>
        <Button
          height="32px"
          variant="flat"
          width="full"
          color="accent"
          symbol="minus.circle"
          disabled={!canAdjust}
          onClick={() => setAmountSheet({ mode: 'decrease', strategy })}
          testId="earn-decrease-button"
        >
          {i18n.t('earn.decrease_short')}
        </Button>
      </Box>

      <Box
        display="flex"
        alignItems="center"
        background="surfacePrimaryElevated"
        borderColor="separatorTertiary"
        borderWidth="1px"
        borderRadius="12px"
        padding="8px"
        gap="4px"
      >
        <ChainBadge chainId={ChainId.base} size="14" />
        <TextOverflow size="12pt" weight="semibold" color="labelSecondary">
          {i18n.t('earn.network_banner')}
        </TextOverflow>
      </Box>

      {closing && (
        <Text size="12pt" weight="medium" color="labelTertiary">
          {i18n.t('earn.closing')}
        </Text>
      )}
      {pausedCount > 0 && (
        <Text size="12pt" weight="medium" color="orange" testId="earn-paused">
          {i18n.t('earn.paused_warning', { count: pausedCount })}
        </Text>
      )}

      <Box paddingTop="8px">
        <Menu>
          <MenuItem
            first
            leftComponent={
              <Symbol
                symbol="slider.horizontal.3"
                weight="semibold"
                size={18}
                color="blue"
              />
            }
            titleComponent={
              <MenuItem.Title text={i18n.t('earn.advanced_settings')} />
            }
            hasRightArrow
            onClick={() => openSettings(strategy)}
            testId="earn-strategy-settings-button"
          />
          <MenuItem
            last
            disabled={!canClose}
            leftComponent={
              <Symbol
                symbol="xmark.circle.fill"
                weight="semibold"
                size={18}
                color="red"
              />
            }
            titleComponent={
              <MenuItem.Title
                color="red"
                text={
                  confirmPaused
                    ? i18n.t('earn.withdraw_anyway')
                    : i18n.t('earn.withdraw')
                }
              />
            }
            hasRightArrow
            onClick={canClose ? onClose : undefined}
            testId="earn-withdraw-button"
          />
        </Menu>
      </Box>
    </Box>
  );
}
