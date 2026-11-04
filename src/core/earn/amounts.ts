export const parseAmount = (text: string): number => {
  const trimmed = text.trim();
  return /^\d*\.?\d+$|^\d+\.?$/.test(trimmed) ? Number(trimmed) : NaN;
};

export type AmountProblem = 'empty' | 'too_low' | 'too_high';

// Checks an amount for the increase and decrease deposit screens. `max` is
// the wallet balance for an increase and the server's limit for a decrease.
export function amountProblem(
  amount: number,
  limits: { min: number; max?: number },
): AmountProblem | null {
  if (!Number.isFinite(amount) || amount <= 0) return 'empty';
  if (limits.max !== undefined && limits.max < limits.min) return 'too_high';
  if (amount < limits.min) return 'too_low';
  if (limits.max !== undefined && amount > limits.max) return 'too_high';
  return null;
}
