import { UsageError } from "../args.js";

/** A task id: a non-negative whole number. */
export function parseTaskId(value: string | undefined): bigint {
  if (value === undefined) throw new UsageError("a task id is required");
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`task id must be a whole number, got '${value}'`);
  }
  return BigInt(value);
}

/** A whole number of the reward token's smallest unit (stroops for XLM). */
export function parseAmount(value: string | undefined, label: string): bigint {
  if (value === undefined) throw new UsageError(`${label} is required`);
  const cleaned = value.replace(/_/g, "");
  if (!/^\d+$/.test(cleaned)) {
    throw new UsageError(
      `${label} must be a whole number of the token's smallest unit (stroops for XLM), got '${value}'`,
    );
  }
  return BigInt(cleaned);
}

/** A positive amount, for commands where zero would be a pointless transaction. */
export function parsePositiveAmount(value: string | undefined, label: string): bigint {
  const amount = parseAmount(value, label);
  if (amount === 0n) throw new UsageError(`${label} must be greater than zero`);
  return amount;
}

/** Unix seconds, or an absolute time `Date` can parse (ISO 8601). */
export function parseTime(value: string | undefined, label: string): Date {
  if (value === undefined) throw new UsageError(`${label} is required`);
  const date = /^\d+$/.test(value) ? new Date(Number(value) * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new UsageError(
      `${label} must be Unix seconds or an ISO 8601 time such as 2030-01-01T00:00:00Z, got '${value}'`,
    );
  }
  return date;
}

/** A whole number of ledgers. */
export function parseLedgers(value: string | undefined, label: string): number {
  if (value === undefined) throw new UsageError(`${label} is required`);
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) {
    throw new UsageError(`${label} must be a whole number of ledgers, got '${value}'`);
  }
  return n;
}

/** Rejects stray positionals so a typo never runs with defaults. */
export function expectPositionals(
  positionals: readonly string[],
  count: number,
  usageLine: string,
): void {
  if (positionals.length < count) throw new UsageError(`usage: ${usageLine}`);
  if (positionals.length > count) {
    throw new UsageError(`unexpected argument '${positionals[count]}'; usage: ${usageLine}`);
  }
}

/** Approximate seconds per ledger on Stellar, for wait estimates only. */
export const SECONDS_PER_LEDGER = 5;

/** "86400 ledgers (about 5.0 days)", for telling someone how long to wait. */
export function describeWait(ledgers: number): string {
  const seconds = ledgers * SECONDS_PER_LEDGER;
  let about: string;
  if (seconds >= 86_400) about = `${(seconds / 86_400).toFixed(1)} days`;
  else if (seconds >= 3_600) about = `${(seconds / 3_600).toFixed(1)} hours`;
  else if (seconds >= 60) about = `${Math.ceil(seconds / 60)} minutes`;
  else about = `${seconds} seconds`;
  return `${ledgers} ledgers (about ${about})`;
}
