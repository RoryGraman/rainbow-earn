import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EarnApprovalItem, EarnConfirmRequest } from '~/core/earn/flow';

import {
  countdownJob,
  phaseIndex,
  phasesOf,
  stepKey,
  stepperOf,
  useEarnRunStore,
  waitCopy,
} from './run';

const USDC_ITEM: EarnApprovalItem = {
  token: '0xusdc',
  label: 'USDC',
  kind: 'usdc',
  chainId: 8453,
  spender: '0xproxy',
  unlimited: false,
  amountUsdc: 600,
};
const vaultItem = (label?: string): EarnApprovalItem => ({
  token: '0xvault',
  label,
  kind: 'share',
  chainId: 8453,
  spender: '0xproxy',
  unlimited: true,
});
const approving = (
  index: number,
  total: number,
  items: EarnApprovalItem[] = [USDC_ITEM],
  purpose: 'deposit' | 'withdraw' = 'deposit',
) => ({ kind: 'approving' as const, index, total, items, purpose });
const request = (kind: EarnConfirmRequest['kind']) =>
  ({ kind }) as EarnConfirmRequest;

describe('useEarnRunStore wait timer', () => {
  afterEach(() => {
    vi.useRealTimers();
    useEarnRunStore.getState().setStep(null);
  });

  it('starts when the wait begins, holds through it, and clears at the end', () => {
    vi.useFakeTimers();
    const store = useEarnRunStore.getState();

    vi.setSystemTime(1000);
    store.setStep({ kind: 'depositing' });
    expect(useEarnRunStore.getState().waitStartedAt).toBe(1000);

    vi.setSystemTime(2000);
    store.setStep({ kind: 'confirming' });
    expect(useEarnRunStore.getState().waitStartedAt).toBe(1000);
    expect(useEarnRunStore.getState().waitStep).toMatchObject({
      kind: 'depositing',
    });

    vi.setSystemTime(9000);
    store.setStep({ kind: 'active', strategyId: 's1' });
    expect(useEarnRunStore.getState().waitStartedAt).toBe(1000);

    store.setStep(null);
    expect(useEarnRunStore.getState().waitStartedAt).toBeNull();
  });

  it('starts a new countdown for each approval transaction', () => {
    vi.useFakeTimers();
    const store = useEarnRunStore.getState();

    vi.setSystemTime(1000);
    store.setStep(approving(1, 2));
    expect(useEarnRunStore.getState().waitStartedAt).toBe(1000);
    vi.setSystemTime(1500);
    store.setStep(approving(1, 2));
    expect(useEarnRunStore.getState().waitStartedAt).toBe(1000);
    vi.setSystemTime(3000);
    store.setStep(approving(2, 2, [vaultItem('Prime')]));
    expect(useEarnRunStore.getState().waitStartedAt).toBe(3000);
    expect(useEarnRunStore.getState().waitStep).toMatchObject({ index: 2 });
  });

  it('ends the countdown when a review opens, and starts again after it', () => {
    vi.useFakeTimers();
    const store = useEarnRunStore.getState();

    vi.setSystemTime(1000);
    store.setStep(approving(1, 1));
    store.setConfirmation(request('deposit'));
    expect(useEarnRunStore.getState().waitStartedAt).toBeNull();
    expect(useEarnRunStore.getState().waitStep).toBeNull();
    store.setConfirmation(null);
    vi.setSystemTime(5000);
    store.setStep({ kind: 'depositing' });
    expect(useEarnRunStore.getState().waitStartedAt).toBe(5000);
    vi.setSystemTime(6000);
    store.setStep({ kind: 'confirming' });
    expect(useEarnRunStore.getState().waitStartedAt).toBe(5000);
  });

  it('keeps the withdrawal countdown through its confirmation', () => {
    vi.useFakeTimers();
    const store = useEarnRunStore.getState();

    vi.setSystemTime(1000);
    store.setStep({ kind: 'withdrawing', index: 1, total: 1 });
    vi.setSystemTime(2000);
    store.setStep({ kind: 'confirming' });
    expect(useEarnRunStore.getState().waitStartedAt).toBe(1000);
    expect(useEarnRunStore.getState().waitStep).toMatchObject({
      kind: 'withdrawing',
    });
  });

  it('starts no countdown for a step that sent no transaction', () => {
    const store = useEarnRunStore.getState();
    store.setStep({ kind: 'active', strategyId: 's1' });
    expect(useEarnRunStore.getState().waitStartedAt).toBeNull();
    store.setStep({ kind: 'closed' });
    expect(useEarnRunStore.getState().waitStartedAt).toBeNull();
    store.setStep({ kind: 'done' });
    expect(useEarnRunStore.getState().waitStartedAt).toBeNull();
  });

  it('holds through the done step of an increase or a decrease', () => {
    vi.useFakeTimers();
    const store = useEarnRunStore.getState();

    vi.setSystemTime(1000);
    store.setStep({ kind: 'withdrawing', index: 1, total: 1 });
    vi.setSystemTime(4000);
    store.setStep({ kind: 'done' });
    expect(useEarnRunStore.getState().waitStartedAt).toBe(1000);
  });
});

describe('stepper', () => {
  afterEach(() => {
    useEarnRunStore.getState().setConfirmation(null);
    useEarnRunStore.getState().setJob(null);
  });

  it('lists the steps of each job', () => {
    expect(phasesOf('start', false)).toEqual(['sign', 'approve', 'deposit']);
    expect(phasesOf('topup', false)).toEqual(['approve', 'deposit']);
    expect(phasesOf('settings', true)).toEqual([]);
    expect(phasesOf(null, false)).toEqual([]);
  });

  it('shows a decrease or a close as steps only when it needs approvals', () => {
    expect(phasesOf('close', false)).toEqual([]);
    expect(phasesOf('decrease', true)).toEqual(['approve', 'withdraw']);
    const store = useEarnRunStore.getState();
    store.setJob('close');
    expect(useEarnRunStore.getState().jobApprovals).toBe(false);
    store.setConfirmation(request('approvals'));
    expect(useEarnRunStore.getState().jobApprovals).toBe(true);
    store.setConfirmation(null);
    store.setJob('decrease');
    expect(useEarnRunStore.getState().jobApprovals).toBe(false);
  });

  it('follows a new strategy from the signature to the open position', () => {
    const phases = phasesOf('start', false);
    const at = (
      step: Parameters<typeof phaseIndex>[1],
      confirmation: EarnConfirmRequest | null = null,
    ) => phaseIndex(phases, step, confirmation);
    expect(at({ kind: 'selecting' }, request('sign_message'))).toBe(0);
    expect(at({ kind: 'creating' })).toBe(1);
    expect(at({ kind: 'resuming' })).toBe(1);
    expect(at({ kind: 'creating' }, request('approvals'))).toBe(1);
    expect(at(approving(3, 3))).toBe(1);
    expect(at(approving(3, 3), request('deposit'))).toBe(2);
    expect(at({ kind: 'confirming' })).toBe(2);
    expect(at({ kind: 'active', strategyId: 's1' })).toBe(3);
  });

  it('follows an increase and a close with approvals', () => {
    const topup = phasesOf('topup', false);
    expect(phaseIndex(topup, { kind: 'preparing' }, null)).toBe(0);
    expect(phaseIndex(topup, approving(1, 1), null)).toBe(0);
    expect(phaseIndex(topup, approving(1, 1), request('deposit'))).toBe(1);
    expect(phaseIndex(topup, { kind: 'depositing' }, null)).toBe(1);
    expect(phaseIndex(topup, { kind: 'done' }, null)).toBe(2);
    const close = phasesOf('close', true);
    expect(phaseIndex(close, { kind: 'preparing' }, null)).toBe(0);
    expect(
      phaseIndex(close, { kind: 'withdrawing', index: 1, total: 1 }, null),
    ).toBe(1);
    expect(phaseIndex(close, { kind: 'closed' }, null)).toBe(2);
  });
});

describe('stepperOf', () => {
  const base = {
    job: 'close' as const,
    jobApprovals: true,
    step: null,
    confirmation: null,
  };

  it('hides the stepper between a decline or an error and the end of the job', () => {
    expect(stepperOf(base)).toBeNull();
  });

  it('shows the steps and the current one during the job', () => {
    expect(
      stepperOf({ ...base, step: { kind: 'withdrawing', index: 1, total: 1 } }),
    ).toEqual({ phases: ['approve', 'withdraw'], current: 1 });
    expect(stepperOf({ ...base, confirmation: request('approvals') })).toEqual({
      phases: ['approve', 'withdraw'],
      current: 0,
    });
  });

  it('hides the stepper for a job with one step', () => {
    expect(
      stepperOf({
        ...base,
        jobApprovals: false,
        confirmation: request('withdraw'),
      }),
    ).toBeNull();
  });
});

describe('waitCopy', () => {
  it('keeps the approval words when the ring runs over', () => {
    expect(waitCopy(approving(1, 6), 'start').overtime).toBeUndefined();
    expect(waitCopy({ kind: 'confirming' }, 'topup').overtime).toEqual({
      title: { key: 'countdown_overtime_title' },
      body: { key: 'countdown_overtime_body' },
    });
  });

  it('names the USDC approval, its amount, and the approvals left', () => {
    expect(waitCopy(approving(1, 3), 'start')).toEqual({
      title: { key: 'wait_approve_usdc_title' },
      body: { key: 'wait_approve_usdc_body', amountUsdc: 600 },
      next: { key: 'wait_next_approvals', count: 2 },
    });
  });

  it('names each vault, and the review after the last approval', () => {
    expect(waitCopy(approving(3, 3, [vaultItem('Prime')]), 'start')).toEqual({
      title: { key: 'wait_approve_vault_title', vault: 'Prime' },
      body: { key: 'wait_approve_vault_body' },
      next: { key: 'wait_next_review_start' },
    });
    expect(waitCopy(approving(1, 1), 'topup').next).toEqual({
      key: 'wait_next_review_topup',
    });
  });

  it('words a withdrawal approval and an unnamed vault', () => {
    expect(
      waitCopy(approving(1, 1, [vaultItem()], 'withdraw'), 'close'),
    ).toEqual({
      title: { key: 'wait_approve_shares_title' },
      body: { key: 'wait_approve_vault_withdraw_body' },
      next: { key: 'wait_next_review_close' },
    });
  });

  it('words a Smart Wallet batch as one transaction', () => {
    const batch = approving(1, 1, [USDC_ITEM, vaultItem('A'), vaultItem('B')]);
    expect(waitCopy(batch, 'start')).toEqual({
      title: { key: 'wait_approve_batch_usdc_title', count: 2 },
      body: { key: 'wait_approve_batch_body' },
      next: { key: 'wait_next_review_start' },
    });
  });

  it('words the deposit and the withdrawal waits by job', () => {
    expect(waitCopy({ kind: 'confirming' }, 'start')).toMatchObject({
      title: { key: 'countdown_start_title' },
      body: { key: 'countdown_start_body' },
      next: { key: 'wait_next_start' },
    });
    expect(
      waitCopy({ kind: 'withdrawing', index: 1, total: 2 }, 'close').next,
    ).toEqual({ key: 'wait_next_transactions', count: 1 });
    expect(
      waitCopy({ kind: 'withdrawing', index: 2, total: 2 }, 'decrease').next,
    ).toEqual({ key: 'wait_next_decrease' });
  });
});

describe('countdownJob', () => {
  it.each(['start', 'close', 'topup', 'decrease'] as const)(
    'shows the countdown for %s during a wait',
    (job) => {
      expect(countdownJob({ job, waitStartedAt: 1000 })).toBe(job);
    },
  );

  it('names increase and decrease steps in their own words', () => {
    expect(stepKey('preparing', 'topup')).toBe('step_preparing_increase');
    expect(stepKey('depositing', 'topup')).toBe('step_depositing_increase');
    expect(stepKey('preparing', 'decrease')).toBe('step_preparing_decrease');
    expect(stepKey('withdrawing', 'decrease')).toBe(
      'step_withdrawing_decrease',
    );
    expect(stepKey('preparing', 'close')).toBe('step_preparing');
    expect(stepKey('confirming', 'topup')).toBe('step_confirming');
  });

  it('shows no countdown for settings or outside a wait', () => {
    expect(countdownJob({ job: 'settings', waitStartedAt: 1000 })).toBeNull();
    expect(countdownJob({ job: 'topup', waitStartedAt: null })).toBeNull();
    expect(countdownJob({ job: null, waitStartedAt: 1000 })).toBeNull();
  });
});
