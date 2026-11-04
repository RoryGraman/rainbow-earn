import { createBaseStore } from '@storesjs/stores';

import type { EarnPickedFee } from '~/core/earn/fees';
import type { EarnConfirmRequest, EarnFlowStep } from '~/core/earn/flow';
import type { SettledStrategy } from '~/core/earn/strategies';
import type { EarnStrategy } from '~/core/earn/types';

export type EarnJob = 'start' | 'close' | 'topup' | 'decrease' | 'settings';

// Steps after the user signed, while the chain and the Earn service catch up.
const WAIT_STEPS = new Set<EarnFlowStep['kind']>([
  'approving',
  'depositing',
  'withdrawing',
  'confirming',
  'active',
  'closed',
  'done',
]);

// Each approval, deposit and withdrawal sends its own transaction, with its
// own countdown.
const TX_STEPS = new Set<EarnFlowStep['kind']>([
  'approving',
  'depositing',
  'withdrawing',
]);
// Only a step after a send starts a countdown. The others keep a running one.
const RING_STEPS = new Set<EarnFlowStep['kind']>([...TX_STEPS, 'confirming']);
const indexOf = (step: EarnFlowStep | null) =>
  step && 'index' in step ? step.index : undefined;

const COUNTDOWN_JOBS = new Set<EarnJob>([
  'start',
  'close',
  'topup',
  'decrease',
]);

// The job whose full-page countdown shows now, or null.
export const countdownJob = ({
  job,
  waitStartedAt,
}: {
  job: EarnJob | null;
  waitStartedAt: number | null;
}) =>
  waitStartedAt !== null && job !== null && COUNTDOWN_JOBS.has(job)
    ? job
    : null;

const JOB_STEP_KEYS: Partial<
  Record<EarnJob, Partial<Record<EarnFlowStep['kind'], string>>>
> = {
  topup: {
    preparing: 'step_preparing_increase',
    depositing: 'step_depositing_increase',
  },
  decrease: {
    preparing: 'step_preparing_decrease',
    withdrawing: 'step_withdrawing_decrease',
  },
};

// The `earn.*` translation key for a progress step of this job.
export const stepKey = (kind: EarnFlowStep['kind'], job: EarnJob | null) =>
  (job && JOB_STEP_KEYS[job]?.[kind]) ?? `step_${kind}`;

// The steps the stepper shows. A decrease or a close shows them only when it
// needs approvals first.
export type EarnPhase = 'sign' | 'approve' | 'deposit' | 'withdraw';

export const phasesOf = (
  job: EarnJob | null,
  jobApprovals: boolean,
): EarnPhase[] => {
  switch (job) {
    case 'start':
      return ['sign', 'approve', 'deposit'];
    case 'topup':
      return ['approve', 'deposit'];
    case 'decrease':
    case 'close':
      return jobApprovals ? ['approve', 'withdraw'] : [];
    default:
      return [];
  }
};

const PHASE_OF_STEP: Partial<Record<EarnFlowStep['kind'], EarnPhase>> = {
  selecting: 'sign',
  signing: 'sign',
  creating: 'approve',
  resuming: 'approve',
  approving: 'approve',
  depositing: 'deposit',
  withdrawing: 'withdraw',
};
const PHASE_OF_REQUEST: Record<EarnConfirmRequest['kind'], EarnPhase> = {
  sign_message: 'sign',
  approvals: 'approve',
  deposit: 'deposit',
  withdraw: 'withdraw',
};

// The current step of the stepper. An open review counts first. A step the
// job skips counts as done. The length means every step is done.
export function phaseIndex(
  phases: EarnPhase[],
  step: EarnFlowStep | null,
  confirmation: EarnConfirmRequest | null,
): number {
  if (step && ['active', 'closed', 'done'].includes(step.kind)) {
    return phases.length;
  }
  if (!confirmation && step?.kind === 'confirming') return phases.length - 1;
  const phase = confirmation
    ? PHASE_OF_REQUEST[confirmation.kind]
    : step && PHASE_OF_STEP[step.kind];
  return Math.max(phase ? phases.indexOf(phase) : 0, 0);
}

// The stepper of the running job, or null. Between a decline or an error and
// the end of the job, step and review are both empty, and it hides.
export function stepperOf({
  job,
  jobApprovals,
  step,
  confirmation,
}: {
  job: EarnJob | null;
  jobApprovals: boolean;
  step: EarnFlowStep | null;
  confirmation: EarnConfirmRequest | null;
}): { phases: EarnPhase[]; current: number } | null {
  const phases = phasesOf(job, jobApprovals);
  if (phases.length < 2 || (!step && !confirmation)) return null;
  return { phases, current: phaseIndex(phases, step, confirmation) };
}

// A translation key under `earn.` with its values. The page formats the amount.
export type EarnCopy = {
  key: string;
  count?: number;
  vault?: string;
  amountUsdc?: number;
};

// What the countdown says: what this transaction does, and what comes next.
// An approval keeps its own words when its ring runs over, because more
// steps follow.
export function waitCopy(
  step: EarnFlowStep,
  job: EarnJob,
): {
  title: EarnCopy;
  body: EarnCopy;
  next: EarnCopy;
  overtime?: { title: EarnCopy; body: EarnCopy };
} {
  if (step.kind === 'approving') {
    const [item] = step.items;
    const next: EarnCopy =
      step.index < step.total
        ? { key: 'wait_next_approvals', count: step.total - step.index }
        : { key: `wait_next_review_${job}` };
    if (step.items.length > 1) {
      const vaults = step.items.filter((i) => i.kind === 'share').length;
      return {
        title: {
          key: step.items.some((i) => i.kind === 'usdc')
            ? 'wait_approve_batch_usdc_title'
            : 'wait_approve_batch_title',
          count: vaults,
        },
        body: { key: 'wait_approve_batch_body' },
        next,
      };
    }
    if (item?.kind === 'usdc') {
      return {
        title: { key: 'wait_approve_usdc_title' },
        body:
          item.amountUsdc === undefined
            ? { key: 'wait_approve_usdc_body_any' }
            : { key: 'wait_approve_usdc_body', amountUsdc: item.amountUsdc },
        next,
      };
    }
    return {
      title: item?.label
        ? { key: 'wait_approve_vault_title', vault: item.label }
        : { key: 'wait_approve_shares_title' },
      body: {
        key:
          step.purpose === 'withdraw'
            ? 'wait_approve_vault_withdraw_body'
            : 'wait_approve_vault_body',
      },
      next,
    };
  }
  const left = step.kind === 'withdrawing' ? step.total - step.index : 0;
  return {
    title: { key: `countdown_${job}_title` },
    body: { key: `countdown_${job}_body` },
    next:
      left > 0
        ? { key: 'wait_next_transactions', count: left }
        : { key: `wait_next_${job}` },
    overtime: {
      title: { key: 'countdown_overtime_title' },
      body: { key: 'countdown_overtime_body' },
    },
  };
}

export type EarnAmountSheetState = {
  mode: 'increase' | 'decrease';
  strategy: EarnStrategy;
};

interface EarnRunState {
  step: EarnFlowStep | null;
  job: EarnJob | null;
  // When the current wait began, for the countdown. Null outside a wait.
  waitStartedAt: number | null;
  // The step that began the current wait. The countdown words come from it.
  waitStep: EarnFlowStep | null;
  // True once the current job asked for approvals.
  jobApprovals: boolean;
  // The fee picked in the review the user last approved. Only the sends of
  // that review use it.
  pickedFee: EarnPickedFee | null;
  error: string | null;
  running: boolean;
  // What the last finished run left behind, until the server list agrees.
  settled: (SettledStrategy & { wallet: string }) | null;
  // The settings sheet renders beside the Earn page content, like Rainbow's
  // other sheets, so it sits on the popup frame and not inside the scrolling
  // content.
  settingsOpen: boolean;
  // The open strategy whose settings the sheet edits. Null edits the defaults
  // for new deposits.
  settingsStrategy: EarnStrategy | null;
  // The increase or decrease deposit sheet, with the strategy it acts on.
  amountSheet: EarnAmountSheetState | null;
  // The signature or transaction waiting for the user's approval. The
  // confirmation sheet shows it. See `confirm.ts` for how it is answered.
  confirmation: EarnConfirmRequest | null;
  // True while the Earn page, and with it the confirmation sheet, is mounted.
  pageOpen: boolean;
  setStep: (step: EarnFlowStep | null) => void;
  setJob: (job: EarnJob | null) => void;
  setError: (error: string | null) => void;
  setRunning: (running: boolean) => void;
  setSettled: (settled: (SettledStrategy & { wallet: string }) | null) => void;
  setSettingsOpen: (open: boolean) => void;
  openSettings: (strategy: EarnStrategy | null) => void;
  setAmountSheet: (sheet: EarnAmountSheetState | null) => void;
  setConfirmation: (confirmation: EarnConfirmRequest | null) => void;
  setPageOpen: (pageOpen: boolean) => void;
}

// Not persisted. It lives outside React, so leaving the Earn page does not
// drop a run in progress or allow a second run next to it.
export const useEarnRunStore = createBaseStore<EarnRunState>((set) => ({
  step: null,
  job: null,
  waitStartedAt: null,
  waitStep: null,
  jobApprovals: false,
  pickedFee: null,
  error: null,
  running: false,
  settled: null,
  settingsOpen: false,
  settingsStrategy: null,
  amountSheet: null,
  confirmation: null,
  pageOpen: false,
  setStep: (step) =>
    set((state) => {
      if (!step || !WAIT_STEPS.has(step.kind)) {
        return { step, waitStep: null, waitStartedAt: null };
      }
      const newTransaction =
        TX_STEPS.has(step.kind) &&
        (state.waitStep?.kind !== step.kind ||
          indexOf(state.waitStep) !== indexOf(step));
      if (
        newTransaction ||
        (state.waitStartedAt === null && RING_STEPS.has(step.kind))
      ) {
        return { step, waitStep: step, waitStartedAt: Date.now() };
      }
      return state.waitStartedAt === null
        ? { step, waitStep: null, waitStartedAt: null }
        : { step };
    }),
  setJob: (job) => set({ job, jobApprovals: false, pickedFee: null }),
  setError: (error) => set({ error }),
  setRunning: (running) => set({ running }),
  setSettled: (settled) =>
    set({ settled: settled && { ...settled, at: Date.now() } }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  openSettings: (settingsStrategy) =>
    set({ settingsOpen: true, settingsStrategy }),
  setAmountSheet: (amountSheet) => set({ amountSheet }),
  // A review ends the countdown before it. The next step starts a new one.
  setConfirmation: (confirmation) =>
    set((state) =>
      confirmation
        ? {
            confirmation,
            pickedFee: null,
            waitStep: null,
            waitStartedAt: null,
            jobApprovals:
              state.jobApprovals || confirmation.kind === 'approvals',
          }
        : { confirmation },
    ),
  setPageOpen: (pageOpen) => set({ pageOpen }),
}));
