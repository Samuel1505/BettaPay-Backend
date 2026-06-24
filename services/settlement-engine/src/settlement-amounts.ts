/**
 * settlement-amounts.ts
 *
 * Pure precision-arithmetic helpers for settlement fee calculations.
 * No I/O, no environment dependencies — safe to import in tests.
 *
 * Precision strategy
 * ──────────────────
 * BigNumber.js is used for all arithmetic with ROUND_DOWN to ensure
 * fees are never over-charged due to rounding.  All amounts are
 * returned as full-precision decimal strings, preserving the number
 * of decimal places present in the original input.
 */

import BigNumber from 'bignumber.js';

// Always round DOWN (conservative/banker-safe), never use scientific notation
BigNumber.config({ ROUNDING_MODE: BigNumber.ROUND_DOWN, EXPONENTIAL_AT: [-20, 40] });

export interface SettlementAmounts {
  /** Exact original input — no rounding applied */
  grossAmount: string;
  /** Fee deducted from gross, rounded DOWN to input decimal places */
  feeAmount: string;
  /** grossAmount − feeAmount, same decimal places as input */
  netAmount: string;
}

/**
 * Computes fee and net amounts with full decimal precision using BigNumber.
 *
 * @param grossAmountStr  Validated numeric string from the request body.
 * @param feeBps          Fee in basis points (e.g. 100 = 1%).
 * @returns               { grossAmount, feeAmount, netAmount } as full-precision strings.
 *
 * @example
 *   computeSettlementAmounts('100.123456', 100)
 *   // → { grossAmount: '100.123456', feeAmount: '1.001234', netAmount: '99.122222' }
 */
export function computeSettlementAmounts(
  grossAmountStr: string,
  feeBps: number
): SettlementAmounts {
  const gross = new BigNumber(grossAmountStr);

  // fee = gross × feeBps / 10 000   (rounded DOWN to preserve net accuracy)
  const fee = gross.multipliedBy(feeBps).dividedBy(10_000);

  // Preserve the same decimal places as the original input string.
  const inputDecimals = (grossAmountStr.split('.')[1] ?? '').length;
  const feeStr = fee.toFixed(inputDecimals, BigNumber.ROUND_DOWN);
  const netStr = gross.minus(feeStr).toFixed(inputDecimals);

  return {
    grossAmount: grossAmountStr,   // exact original — zero rounding
    feeAmount: feeStr,
    netAmount: netStr,
  };
}
