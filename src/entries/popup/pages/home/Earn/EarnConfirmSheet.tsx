import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';

import { EARN_TERMS_URL } from '~/core/earn/defaults';
import {
  type EarnPickedFee,
  displayFeeUsd,
  nativeAssetForFee,
} from '~/core/earn/fees';
import type {
  EarnConfirmRequest,
  EarnReviewGas,
  StrategyPatch,
} from '~/core/earn/flow';
import { repeatedNameDetails } from '~/core/earn/vaults';
import { i18n } from '~/core/languages';
import {
  useCurrentAddressStore,
  useCurrentCurrencyStore,
  useGasStore,
} from '~/core/state';
import { answerConfirmation } from '~/core/state/earn/confirm';
import { useEarnRunStore } from '~/core/state/earn/run';
import type { ParsedUserAsset } from '~/core/types/assets';
import { ChainId } from '~/core/types/chains';
import { getBlockExplorerHostForChain, getChain } from '~/core/utils/chains';
import { copyAddress } from '~/core/utils/copy';
import { getExplorerUrl, goToNewTab } from '~/core/utils/tabs';
import {
  Box,
  Button,
  ButtonSymbol,
  Separator,
  Stack,
  Symbol,
  Text,
  TextOverflow,
} from '~/design-system';
import { AccentColorProvider } from '~/design-system/components/Box/ColorContext';
import { transparentAccentColorAsHsl } from '~/design-system/styles/core.css';
import type { TextColor } from '~/design-system/styles/designTokens';

import { Navbar } from '../../../components/Navbar/Navbar';
import { Fee } from '../../../components/TransactionFee/TransactionFee';
import { useDefaultTxSpeed } from '../../../hooks/useDefaultTxSpeed';
import { useTransactionGas } from '../../../hooks/useGas';
import { useWillExecuteDelegation } from '../../../hooks/useWillExecuteDelegation';

import { EARN_ACCENT, EarnCoin, EarnStepper, chainName } from './EarnParts';
import { EarnSheet } from './EarnSheet';
import { formatPercent, formatUsd } from './earnFormat';
import { useNativePrices } from './useEarnData';

const shorten = (address: string) =>
  address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

function Row({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string | null;
  children: ReactNode;
}) {
  return (
    <Box
      display="flex"
      alignItems="center"
      justifyContent="space-between"
      gap="12px"
      style={{ minHeight: 32 }}
    >
      <Stack space="6px">
        <Text size="14pt" weight="semibold" color="labelSecondary">
          {label}
        </Text>
        {detail && (
          <Text size="12pt" weight="medium" color="labelTertiary">
            {detail}
          </Text>
        )}
      </Stack>
      {children}
    </Box>
  );
}

function Value({
  children,
  color = 'label',
}: {
  children: ReactNode;
  color?: TextColor;
}) {
  return (
    <Box style={{ maxWidth: 180, minWidth: 0 }}>
      <TextOverflow size="14pt" weight="semibold" color={color}>
        {children}
      </TextOverflow>
    </Box>
  );
}

// The explorer opens in a background tab, so the review stays open.
function ContractValue({
  address,
  chainId,
}: {
  address: string;
  chainId: number;
}) {
  const explorer = getBlockExplorerHostForChain(chainId as ChainId);
  return (
    <Box display="flex" alignItems="center" gap="4px">
      <Box
        onClick={() =>
          explorer &&
          goToNewTab({ url: getExplorerUrl(explorer, address), active: false })
        }
        style={{ cursor: explorer ? 'pointer' : undefined }}
        testId="earn-contract-link"
      >
        <Text
          size="14pt"
          weight="semibold"
          color={explorer ? 'accent' : 'label'}
        >
          {shorten(address)}
        </Text>
      </Box>
      <ButtonSymbol
        symbol="square.on.square"
        symbolSize={12}
        color="labelTertiary"
        height="24px"
        variant="transparentHover"
        onClick={() => copyAddress(address as Address)}
        testId="earn-contract-copy"
      />
    </Box>
  );
}

function EarnMark() {
  return (
    <Box
      display="flex"
      alignItems="center"
      justifyContent="center"
      borderRadius="round"
      style={{ width: 36, height: 36, background: EARN_ACCENT }}
    >
      <Symbol
        symbol="chart.line.uptrend.xyaxis"
        size={16}
        weight="bold"
        color="labelWhite"
      />
    </Box>
  );
}

function Card({
  icon,
  title,
  subtitle,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <Box
      borderRadius="24px"
      paddingHorizontal="8px"
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap="10px"
      style={{
        width: 143,
        height: 128,
        backgroundColor: transparentAccentColorAsHsl,
      }}
    >
      {icon}
      <TextOverflow size="14pt" weight="bold" color="label">
        {title}
      </TextOverflow>
      <TextOverflow size="12pt" weight="bold" color="labelSecondary">
        {subtitle}
      </TextOverflow>
    </Box>
  );
}

function Cards({ from, to }: { from: ReactNode; to: ReactNode }) {
  return (
    <Box display="flex" alignItems="center" justifyContent="center">
      {from}
      <Box
        display="flex"
        alignItems="center"
        justifyContent="center"
        background="surfaceSecondaryElevated"
        borderRadius="round"
        borderWidth="1px"
        borderColor="buttonStroke"
        boxShadow="12px"
        style={{ width: 32, height: 32, margin: '0 -11px', zIndex: 1 }}
      >
        <Symbol
          symbol="chevron.right"
          size={11}
          weight="bold"
          color="labelTertiary"
        />
      </Box>
      {to}
    </Box>
  );
}

const usdcCard = (title: string, subtitle: string) => (
  <Card icon={<EarnCoin size={36} />} title={title} subtitle={subtitle} />
);
const earnCard = (subtitle: string) => (
  <Card
    icon={<EarnMark />}
    title={i18n.t('earn.position_name')}
    subtitle={subtitle}
  />
);

type Review = {
  title: string;
  body: string;
  button: string;
  cards?: ReactNode;
  rows: ReactNode;
  more?: ReactNode;
};

const SETTING_LABELS: Record<keyof StrategyPatch, string> = {
  delta_pct: 'earn.settings_delta_pct',
  delta_confirmations: 'earn.settings_delta_confirmations',
  min_tvl_usd: 'earn.settings_min_tvl',
  min_liquidity_usd: 'earn.settings_min_liquidity',
  apy_smoothing_minutes: 'earn.settings_apy_window',
};

// The exact value that is signed, never rounded.
const settingValue = (field: keyof StrategyPatch, value?: number) => {
  if (value === undefined) return '--';
  switch (field) {
    case 'delta_pct':
      return `${value}%`;
    case 'min_tvl_usd':
    case 'min_liquidity_usd':
      return `$${value.toLocaleString('en-US', { maximumFractionDigits: 6 })}`;
    case 'apy_smoothing_minutes':
      return i18n.t('earn.review_minutes', { count: value });
    default:
      return String(value);
  }
};

// The vaults that rank highest now. The deposit review shows the final split.
function VaultsRow({
  vaults,
}: {
  vaults: { address: string; name: string; apy: number | null }[];
}) {
  const [open, setOpen] = useState(false);
  const details = repeatedNameDetails(vaults);
  return (
    <>
      <Row label={i18n.t('earn.info_vaults')}>
        <Box display="flex" alignItems="center" gap="8px">
          <Box
            onClick={() => setOpen(!open)}
            style={{ cursor: 'pointer' }}
            testId="earn-confirm-vault-count"
          >
            <Value>
              {i18n.t('earn.review_vault_count', { count: vaults.length })}
            </Value>
          </Box>
          <Box
            style={{
              transform: open ? 'rotate(180deg)' : undefined,
              transition: 'transform 0.2s',
            }}
          >
            <ButtonSymbol
              symbol="chevron.down.circle"
              symbolSize={12}
              color="labelQuaternary"
              height="24px"
              variant="tinted"
              onClick={() => setOpen(!open)}
              testId="earn-confirm-vaults"
            />
          </Box>
        </Box>
      </Row>
      {open && (
        <Box paddingLeft="12px" testId="earn-confirm-vault-list">
          <Stack space="4px">
            <Box testId="earn-confirm-vaults-note">
              <Text size="12pt" weight="medium" color="labelTertiary">
                {i18n.t('earn.review_vaults_preview')}
              </Text>
            </Box>
            {vaults.map((vault, i) => (
              <Row key={vault.address} label={vault.name} detail={details[i]}>
                <Value color={vault.apy === null ? 'labelTertiary' : 'green'}>
                  {vault.apy === null
                    ? '--'
                    : i18n.t('earn.apy', { value: formatPercent(vault.apy) })}
                </Value>
              </Row>
            ))}
          </Stack>
        </Box>
      )}
    </>
  );
}

const networkRow = (chainIds: number[]) => (
  <Row label={i18n.t('earn.info_network')}>
    <Value>{[...new Set(chainIds)].map(chainName).join(', ')}</Value>
  </Row>
);

function reviewFor(
  request: EarnConfirmRequest,
  willDelegate: boolean,
  topUp: boolean,
): Review {
  switch (request.kind) {
    case 'sign_message': {
      const action =
        request.action === 'strategy.delete'
          ? 'delete'
          : request.action === 'strategy.update'
          ? 'update'
          : 'terms';
      return {
        title: i18n.t(`earn.review_sign_${action}`),
        body: i18n.t(`earn.confirm_${action}_body`),
        button: i18n.t('earn.confirm_sign'),
        rows: (
          <>
            <Row label={i18n.t('earn.review_action')}>
              <Value>{i18n.t(`earn.review_action_${action}`)}</Value>
            </Row>
            {request.changes?.map((change) => (
              <Row
                key={change.field}
                label={i18n.t(SETTING_LABELS[change.field])}
              >
                <Box style={{ maxWidth: 200 }}>
                  <Text
                    size="14pt"
                    weight="semibold"
                    color="label"
                    align="right"
                  >
                    {`${settingValue(
                      change.field,
                      change.from,
                    )} → ${settingValue(change.field, change.to)}`}
                  </Text>
                </Box>
              </Row>
            ))}
            {request.summary && (
              <>
                <Row label={i18n.t('earn.review_deposit_amount')}>
                  <Value>{formatUsd(request.summary.capitalUsdc)}</Value>
                </Row>
                <VaultsRow
                  key={request.message}
                  vaults={request.summary.vaults}
                />
              </>
            )}
            <Row label={i18n.t('earn.review_gas')}>
              <Value color="green">{i18n.t('earn.review_free')}</Value>
            </Row>
            {action === 'terms' && (
              <Row label={i18n.t('earn.review_terms')}>
                <Box
                  onClick={() => goToNewTab({ url: EARN_TERMS_URL })}
                  style={{ cursor: 'pointer' }}
                >
                  <Text size="14pt" weight="semibold" color="accent">
                    {i18n.t('earn.terms_link')}
                  </Text>
                </Box>
              </Row>
            )}
            {networkRow([ChainId.base])}
          </>
        ),
        more: (
          <Box
            background="surfaceSecondaryElevated"
            borderRadius="16px"
            padding="16px"
            testId="earn-confirm-message"
          >
            <Text size="12pt" weight="medium" color="labelSecondary">
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {request.message}
              </span>
            </Text>
          </Box>
        ),
      };
    }
    case 'approvals': {
      const usdc = request.items.find((item) => item.kind === 'usdc');
      const shares = request.items.filter((item) => item.kind === 'share');
      const shareDetails = repeatedNameDetails(
        shares.map((item) => ({
          name: item.label ?? item.token,
          address: item.token,
        })),
      );
      const allUnlimited = shares.every((item) => item.unlimited);
      const { batched } = request;
      return {
        title: i18n.t('earn.review_approvals'),
        body: [
          i18n.t(
            batched
              ? 'earn.confirm_approvals_body_batched'
              : 'earn.confirm_approvals_body',
            { spender: shorten(request.spender) },
          ),
          batched && willDelegate
            ? i18n.t('earn.review_smart_wallet_note')
            : '',
        ]
          .filter(Boolean)
          .join(' '),
        button: i18n.t('earn.confirm_approvals_button', {
          count: request.items.length,
        }),
        rows: (
          <>
            {usdc && (
              <Row label="USDC">
                {usdc.unlimited ? (
                  <Value color="orange">
                    {i18n.t('earn.confirm_no_limit')}
                  </Value>
                ) : (
                  <Value>
                    {i18n.t('earn.confirm_up_to', {
                      amount: formatUsd(usdc.amountUsdc ?? 0),
                    })}
                  </Value>
                )}
              </Row>
            )}
            {shares.length > 0 && (
              <Row label={i18n.t('earn.review_vault_shares')}>
                <Value color={allUnlimited ? 'orange' : 'label'}>
                  {i18n.t(
                    allUnlimited
                      ? 'earn.review_vaults_no_limit'
                      : 'earn.review_vault_count',
                    { count: shares.length },
                  )}
                </Value>
              </Row>
            )}
            {batched && willDelegate && (
              <Row label={i18n.t('earn.review_smart_wallet')}>
                <Value color="orange">
                  {i18n.t('earn.review_smart_wallet_activates')}
                </Value>
              </Row>
            )}
            <Row label={i18n.t('earn.confirm_contract')}>
              <ContractValue
                address={request.spender}
                chainId={request.items[0]?.chainId ?? ChainId.base}
              />
            </Row>
            {networkRow(request.items.map((item) => item.chainId))}
          </>
        ),
        more: shares.length > 0 && (
          <>
            {shares.map((item, i) => (
              <Row
                key={item.token}
                label={item.label ?? shorten(item.token)}
                detail={shareDetails[i]}
              >
                <Value color={item.unlimited ? 'orange' : 'label'}>
                  {i18n.t(
                    item.unlimited
                      ? 'earn.confirm_no_limit'
                      : 'earn.review_limited',
                  )}
                </Value>
              </Row>
            ))}
          </>
        ),
      };
    }
    case 'deposit': {
      const details = repeatedNameDetails(request.vaults);
      return {
        title: i18n.t(
          topUp ? 'earn.review_increase_title' : 'earn.review_deposit_title',
        ),
        body: i18n.t('earn.confirm_deposit_body'),
        button: i18n.t(
          topUp ? 'earn.review_increase_button' : 'earn.review_deposit_button',
          { amount: formatUsd(request.amountUsdc) },
        ),
        cards: (
          <Cards
            from={usdcCard(
              `${formatUsd(request.amountUsdc).replace('$', '')} USDC`,
              formatUsd(request.amountUsdc),
            )}
            to={earnCard(
              i18n.t('earn.review_vault_count', {
                count: request.vaults.length,
              }),
            )}
          />
        ),
        // The plan's own vaults, so the user sees where the money goes.
        rows: (
          <>
            {request.vaults.map((vault, i) => (
              <Row key={vault.address} label={vault.name} detail={details[i]}>
                <Value>{formatUsd(vault.amountUsdc)}</Value>
              </Row>
            ))}
            <Row label={i18n.t('earn.confirm_contract')}>
              <ContractValue address={request.to} chainId={request.chainId} />
            </Row>
            {networkRow([request.chainId])}
          </>
        ),
      };
    }
    case 'withdraw': {
      const { partial } = request;
      // The contract has the same address on every chain, so several rows
      // name their chain.
      const targets = [
        ...new Map(
          request.transactions.map((tx) => [
            `${tx.chainId}:${tx.to.toLowerCase()}`,
            tx,
          ]),
        ).values(),
      ];
      const contracts = targets.map((tx) => (
        <Row
          key={`${tx.chainId}:${tx.to.toLowerCase()}`}
          label={i18n.t('earn.confirm_contract')}
          detail={targets.length > 1 ? chainName(tx.chainId) : null}
        >
          <ContractValue address={tx.to} chainId={tx.chainId} />
        </Row>
      ));
      if (partial) {
        return {
          title: i18n.t('earn.review_withdraw_title'),
          body: i18n.t('earn.confirm_partial_body', {
            count: request.transactions.length,
          }),
          button: i18n.t('earn.review_withdraw_button', {
            amount: formatUsd(partial.amountUsdc),
          }),
          cards: (
            <Cards
              from={earnCard(formatUsd(partial.amountUsdc))}
              to={usdcCard(
                `${formatUsd(partial.receiveUsdc).replace('$', '')} USDC`,
                formatUsd(partial.receiveUsdc),
              )}
            />
          ),
          rows: (
            <>
              {partial.feeUsdc > 0 && (
                <Row label={i18n.t('earn.confirm_partial_fee')}>
                  <Value>{displayFeeUsd(partial.feeUsdc)}</Value>
                </Row>
              )}
              <Row label={i18n.t('earn.confirm_partial_receive')}>
                <Value color="green">{formatUsd(partial.receiveUsdc)}</Value>
              </Row>
              {contracts}
              {networkRow(request.transactions.map((tx) => tx.chainId))}
            </>
          ),
        };
      }
      const { amountUsdc } = request;
      return {
        title: i18n.t('earn.review_close_title'),
        body: i18n.t('earn.confirm_withdraw_body', {
          count: request.transactions.length,
        }),
        // Paused positions stay in their vaults, so never claim "everything".
        button:
          amountUsdc === undefined
            ? i18n.t('earn.withdraw')
            : i18n.t('earn.review_close_button', {
                amount: formatUsd(amountUsdc),
              }),
        cards:
          amountUsdc === undefined ? (
            <Cards
              from={earnCard(
                [...new Set(request.transactions.map((tx) => tx.chainId))]
                  .map(chainName)
                  .join(', '),
              )}
              to={usdcCard('USDC', i18n.t('earn.review_to_wallet'))}
            />
          ) : (
            <Cards
              from={earnCard(formatUsd(amountUsdc))}
              to={usdcCard(
                `${formatUsd(amountUsdc).replace('$', '')} USDC`,
                i18n.t('earn.review_to_wallet'),
              )}
            />
          ),
        rows: (
          <>
            {contracts}
            {networkRow(request.transactions.map((tx) => tx.chainId))}
          </>
        ),
      };
    }
    default:
      return { title: '', body: '', button: '', rows: null };
  }
}

function ApproveButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      height="44px"
      variant="flat"
      color={disabled ? 'surfaceSecondary' : 'accent'}
      width="full"
      disabled={disabled}
      onClick={onClick}
      testId="earn-confirm-approve"
    >
      <TextOverflow
        size="16pt"
        weight="bold"
        color={disabled ? 'labelQuaternary' : 'label'}
      >
        {label}
      </TextOverflow>
    </Button>
  );
}

const FEE_WAIT_MS = 5000;

// The fee counts every transaction of the review when each has a gas estimate,
// else only the first. As on Rainbow's own reviews, the L1 data fee counts once.
function EarnFeeApprove({
  gas,
  address,
  label,
  onApprove,
}: {
  gas: EarnReviewGas;
  address: Address;
  label: string;
  onApprove: (fee?: EarnPickedFee) => void;
}) {
  const chainId = gas.chainId as ChainId;
  const { defaultTxSpeed } = useDefaultTxSpeed({ chainId });
  const transactionRequest = useMemo(
    () => ({ from: address, to: gas.tx.to, data: gas.tx.data, chainId }),
    [address, gas.tx.to, gas.tx.data, chainId],
  );
  // Without Rainbow's native asset (no Rainbow keys, or no ETH on the chain),
  // the Earn API's USD price stands in, for USD only.
  const { data: prices } = useNativePrices();
  const { currentCurrency } = useCurrentCurrencyStore();
  const symbol = getChain({ chainId }).nativeCurrency.symbol;
  const nativeAssetFallback = useMemo(
    () =>
      currentCurrency === 'USD'
        ? (nativeAssetForFee(symbol, prices?.[chainId]) as
            | ParsedUserAsset
            | undefined)
        : undefined,
    [currentCurrency, symbol, prices, chainId],
  );
  const fee = useTransactionGas({
    chainId,
    address,
    defaultSpeed: defaultTxSpeed,
    transactionRequest,
    simulatedGasLimit: gas.gasLimit?.toString(),
    nativeAssetFallback,
  });
  const picked = fee.gasFeeParamsBySpeed?.[fee.selectedSpeed];
  // A custom fee from another screen must not show here, and one set here
  // must not reach another screen. Rainbow's Send and Swap clear it too.
  useEffect(() => {
    useGasStore.getState().clearCustomGasModified();
    return () => useGasStore.getState().clearCustomGasModified();
  }, []);
  // The button waits for the fee of the picked speed. Without one after 5 s,
  // it turns on, and the sends use the network's current fee.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), FEE_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Stack space="20px">
      <Fee
        chainId={chainId}
        accentColor={EARN_ACCENT}
        selectedSpeed={fee.selectedSpeed}
        setSelectedSpeed={fee.setSelectedSpeed}
        gasFeeParamsBySpeed={fee.gasFeeParamsBySpeed}
        isLoading={fee.isLoading}
        currentBaseFee={fee.currentBaseFee}
        baseFeeTrend={fee.baseFeeTrend}
        feeType={fee.feeType}
        setCustomMaxBaseFee={fee.setCustomMaxBaseFee}
        setCustomMaxPriorityFee={fee.setCustomMaxPriorityFee}
        setCustomGasPrice={fee.setCustomGasPrice}
        feeLabel={i18n.t('earn.review_fee_label', {
          count: gas.gasLimit === undefined ? 1 : gas.count,
        })}
      />
      <ApproveButton
        label={label}
        disabled={!picked && !waited}
        onClick={() =>
          onApprove(picked && { chainId, ...picked.transactionGasParams })
        }
      />
    </Stack>
  );
}

// Rainbow signs with no screen of its own, so every Earn signature stops here
// first. Only the bottom button signs. A tap outside does nothing, so closing
// the speed menu cannot decline by accident.
export function EarnConfirmSheet() {
  const request = useEarnRunStore((s) => s.confirmation);
  const { currentAddress } = useCurrentAddressStore();
  const willDelegate = useWillExecuteDelegation(currentAddress, ChainId.base);
  const topUp = useEarnRunStore((s) => s.job === 'topup');
  const reject = () => answerConfirmation(false);
  const review = request ? reviewFor(request, willDelegate, topUp) : null;
  // "More details" stays open only for the review it was opened on. A new
  // request can replace the old one without this sheet's own handlers.
  const [moreFor, setMoreFor] = useState<EarnConfirmRequest | null>(null);
  const moreOpen = request !== null && moreFor === request;
  const setMoreOpen = (open: boolean) => setMoreFor(open ? request : null);
  const approve = (fee?: EarnPickedFee) => {
    setMoreOpen(false);
    answerConfirmation(true, fee);
  };

  return (
    <EarnSheet show={request !== null}>
      <AccentColorProvider color={EARN_ACCENT}>
        <Box
          background="surfacePrimaryElevatedSecondary"
          style={{ borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
        >
          <Stack space="12px">
            <Navbar
              title={review?.title ?? ''}
              leftComponent={
                <Navbar.CloseButton
                  testId="earn-confirm"
                  onClick={() => {
                    setMoreOpen(false);
                    reject();
                  }}
                />
              }
            />
            <EarnStepper />
            {review?.cards}
            {review && (
              <Box
                paddingHorizontal="20px"
                paddingBottom="16px"
                style={{ maxHeight: 250, overflowY: 'auto' }}
              >
                <Stack space="4px">
                  {review.rows}
                  {review.more && !moreOpen && (
                    <Row label={i18n.t('earn.review_more')}>
                      <ButtonSymbol
                        symbol="chevron.down.circle"
                        symbolSize={12}
                        color="labelQuaternary"
                        height="24px"
                        variant="tinted"
                        onClick={() => setMoreOpen(true)}
                        testId="earn-confirm-more"
                      />
                    </Row>
                  )}
                  {moreOpen && review.more}
                  <Box paddingTop="8px">
                    <Text size="12pt" weight="medium" color="labelTertiary">
                      {review.body}
                    </Text>
                  </Box>
                </Stack>
              </Box>
            )}
          </Stack>
        </Box>
        <Separator strokeWeight="1px" color="separatorSecondary" />
        {review && request && (
          <Box padding="20px">
            {'gas' in request && request.gas ? (
              <EarnFeeApprove
                key={`${request.kind}:${request.gas.tx.to}:${request.gas.tx.data}`}
                gas={request.gas}
                address={currentAddress}
                label={review.button}
                onApprove={approve}
              />
            ) : (
              <ApproveButton label={review.button} onClick={() => approve()} />
            )}
          </Box>
        )}
      </AccentColorProvider>
    </EarnSheet>
  );
}
