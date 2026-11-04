import { useState } from 'react';

import { DEFAULT_EARN_SETTINGS } from '~/core/earn/defaults';
import type { StrategyPatch } from '~/core/earn/flow';
import type {
  EarnEnvironmentName,
  EarnSettings,
  EarnStrategy,
} from '~/core/earn/types';
import { i18n } from '~/core/languages';
import { useCurrentAddressStore } from '~/core/state';
import { useEarnStore } from '~/core/state/earn';
import { useEarnRunStore } from '~/core/state/earn/run';
import { Box, Button, Inline, Separator, Stack } from '~/design-system';
import { AccentColorProvider } from '~/design-system/components/Box/ColorContext';
import { Input } from '~/design-system/components/Input/Input';

import { Menu } from '../../../components/Menu/Menu';
import { MenuItem } from '../../../components/Menu/MenuItem';
import { Navbar } from '../../../components/Navbar/Navbar';

import { EARN_ACCENT, PrimaryButton } from './EarnParts';
import { EarnSheet } from './EarnSheet';
import { useEarnRunner } from './useEarnRunner';

type NumericKey = Exclude<keyof EarnSettings, 'environment' | 'chainId'>;

type Field = {
  key: NumericKey;
  label: string;
  min: number;
  max?: number;
  integer?: boolean;
  // The key the server uses for an open strategy. Missing: not editable there.
  patchKey?: keyof StrategyPatch;
};

const NUMERIC_FIELDS: Field[] = [
  {
    key: 'vaultCount',
    label: 'earn.settings_vault_count',
    min: 1,
    max: 10,
    integer: true,
  },
  {
    key: 'deltaPct',
    label: 'earn.settings_delta_pct',
    min: 0.25,
    patchKey: 'delta_pct',
  },
  {
    key: 'deltaConfirmations',
    label: 'earn.settings_delta_confirmations',
    min: 1,
    integer: true,
    patchKey: 'delta_confirmations',
  },
  {
    key: 'minTvlUsd',
    label: 'earn.settings_min_tvl',
    min: 0,
    patchKey: 'min_tvl_usd',
  },
  {
    key: 'minLiquidityUsd',
    label: 'earn.settings_min_liquidity',
    min: 0,
    patchKey: 'min_liquidity_usd',
  },
  {
    key: 'apySmoothingMinutes',
    label: 'earn.settings_apy_window',
    min: 5,
    max: 1440,
    integer: true,
    patchKey: 'apy_smoothing_minutes',
  },
];

const isValid = (field: Field, value: number) =>
  Number.isFinite(value) &&
  value >= field.min &&
  (field.max === undefined || value <= field.max) &&
  (!field.integer || Number.isInteger(value));

function NumberSetting({
  field,
  value,
  onCommit,
  onValidity,
  first,
}: {
  field: Field;
  value: number;
  onCommit: (value: number) => void;
  onValidity?: (valid: boolean) => void;
  first?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const valid = text.trim() !== '' && isValid(field, Number(text));

  return (
    <MenuItem
      first={first}
      titleComponent={<MenuItem.Title text={i18n.t(field.label)} />}
      rightComponent={
        <Box style={{ width: 96 }}>
          <Input
            variant="surfaceBordered"
            height="32px"
            textAlign="right"
            value={text}
            borderColor={valid ? undefined : 'red'}
            onChange={(e) => {
              setText(e.target.value);
              const ok =
                e.target.value.trim() !== '' &&
                isValid(field, Number(e.target.value));
              onValidity?.(ok);
              if (ok) onCommit(Number(e.target.value));
            }}
            testId={`earn-setting-${field.key}`}
          />
        </Box>
      }
    />
  );
}

// The defaults used for the next new deposit.
function DefaultsForm() {
  const settings = useEarnStore((s) => s.settings);
  const updateSettings = useEarnStore((s) => s.updateSettings);
  const resetSettings = useEarnStore((s) => s.resetSettings);
  // Remount the inputs after a reset so they show the default values.
  const [resetCount, setResetCount] = useState(0);
  const environments: EarnEnvironmentName[] = ['production', 'staging'];

  return (
    <Stack space="20px">
      <Menu>
        <MenuItem
          first
          last
          titleComponent={
            <MenuItem.Title text={i18n.t('earn.settings_environment')} />
          }
          rightComponent={
            <Inline space="6px" wrap={false}>
              {environments.map((name) => (
                <Button
                  key={name}
                  height="28px"
                  variant={
                    settings.environment === name
                      ? 'tinted'
                      : 'transparentHover'
                  }
                  color={
                    settings.environment === name ? 'accent' : 'labelTertiary'
                  }
                  onClick={() => updateSettings({ environment: name })}
                  testId={`earn-setting-env-${name}`}
                >
                  {i18n.t(`earn.settings_${name}`)}
                </Button>
              ))}
            </Inline>
          }
        />
      </Menu>
      <Menu>
        {NUMERIC_FIELDS.map((field, i) => (
          <NumberSetting
            key={`${field.key}-${resetCount}`}
            field={field}
            value={settings[field.key]}
            onCommit={(value) => updateSettings({ [field.key]: value })}
            first={i === 0}
          />
        ))}
        <MenuItem.Description text={i18n.t('earn.settings_note')} />
      </Menu>
      <Button
        height="44px"
        variant="flat"
        color="separatorSecondary"
        width="full"
        disabled={
          JSON.stringify(settings) === JSON.stringify(DEFAULT_EARN_SETTINGS)
        }
        onClick={() => {
          resetSettings();
          setResetCount((n) => n + 1);
        }}
      >
        {i18n.t('earn.settings_reset')}
      </Button>
    </Stack>
  );
}

const STRATEGY_FIELDS = NUMERIC_FIELDS.filter((f) => f.patchKey);

const strategyValue = (strategy: EarnStrategy, key: NumericKey) => {
  switch (key) {
    case 'deltaPct':
      return strategy.delta_pct;
    case 'deltaConfirmations':
      return strategy.delta_confirmations;
    case 'minTvlUsd':
      return strategy.min_tvl_usd;
    case 'minLiquidityUsd':
      return strategy.min_liquidity_usd;
    default:
      return strategy.apy_smoothing_minutes;
  }
};

// The advanced settings of the open strategy. Saving signs one message, after
// the user approves it.
function StrategyForm({
  strategy,
  onSaved,
}: {
  strategy: EarnStrategy;
  onSaved: () => void;
}) {
  const { currentAddress } = useCurrentAddressStore();
  const runner = useEarnRunner(currentAddress);
  const [draft, setDraft] = useState<StrategyPatch>({});
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const canSave =
    Object.keys(draft).length > 0 && invalid.size === 0 && !runner.running;

  return (
    <Stack space="20px">
      <Menu>
        <MenuItem
          first
          titleComponent={
            <MenuItem.Title text={i18n.t('earn.settings_vault_count')} />
          }
          rightComponent={
            <MenuItem.Selection text={String(strategy.max_positions)} />
          }
        />
        <MenuItem.Description text={i18n.t('earn.settings_fixed_note')} />
      </Menu>
      <Menu>
        {STRATEGY_FIELDS.map((field, i) => {
          const current = strategyValue(strategy, field.key);
          if (current === undefined) return null;
          return (
            <NumberSetting
              key={field.key}
              field={field}
              value={current}
              first={i === 0}
              onValidity={(ok) =>
                setInvalid((prev) => {
                  const next = new Set(prev);
                  if (ok) next.delete(field.key);
                  else next.add(field.key);
                  return next;
                })
              }
              onCommit={(value) =>
                setDraft((prev) => {
                  const next = { ...prev };
                  if (value === current) delete next[field.patchKey!];
                  else next[field.patchKey!] = value;
                  return next;
                })
              }
            />
          );
        })}
        <MenuItem.Description text={i18n.t('earn.settings_live_note')} />
      </Menu>
      <PrimaryButton
        label={i18n.t('earn.settings_save')}
        enabled={canSave}
        onClick={() => {
          onSaved();
          const before: StrategyPatch = {};
          STRATEGY_FIELDS.forEach((field) => {
            if (field.patchKey! in draft) {
              before[field.patchKey!] = strategyValue(strategy, field.key);
            }
          });
          runner.saveSettings(strategy.id, draft, before);
        }}
        testId="earn-settings-save"
      />
    </Stack>
  );
}

// Rendered once by the Earn page, beside its content. Opened through
// `useEarnRunStore`: with an open strategy it shows that strategy's advanced
// settings, without one it shows the defaults for new deposits.
export function EarnSettingsSheet() {
  const show = useEarnRunStore((s) => s.settingsOpen);
  const strategy = useEarnRunStore((s) => s.settingsStrategy);
  const setSettingsOpen = useEarnRunStore((s) => s.setSettingsOpen);
  const onClose = () => setSettingsOpen(false);

  return (
    <EarnSheet show={show} onClickOutside={onClose}>
      <AccentColorProvider color={EARN_ACCENT}>
        <Navbar
          title={
            strategy
              ? i18n.t('earn.advanced_settings')
              : i18n.t('earn.settings')
          }
          leftComponent={
            <Navbar.CloseButton testId="earn-settings" onClick={onClose} />
          }
        />
        <Separator color="separatorTertiary" />
        <Box padding="20px">
          {strategy ? (
            <StrategyForm
              key={strategy.id}
              strategy={strategy}
              onSaved={onClose}
            />
          ) : (
            <DefaultsForm />
          )}
        </Box>
      </AccentColorProvider>
    </EarnSheet>
  );
}
