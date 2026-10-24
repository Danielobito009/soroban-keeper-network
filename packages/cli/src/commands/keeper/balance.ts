import { Address } from "@stellar/stellar-sdk";
import { parseCommandArgs, UsageError, type CommandContext } from "../../args.js";
import { type RunResult } from "../../output.js";
import { describeWait } from "../parse.js";
import { finish, openReadOnly, type Session } from "../session.js";
import { keeperToLookUp } from "./target.js";

/** What `scValToNative` makes of the contract's `ReputationRecord`. */
interface RawReputation {
  successes: bigint | number;
  missed_claims: bigint | number;
  score_bps: number | bigint;
  last_updated_ledger: number | bigint;
}

export interface Reputation {
  /** Score in basis points, decayed to the current ledger. */
  scoreBps: number;
  successes: number;
  missedClaims: number;
}

/**
 * The keeper's reputation as of now. This reads the contract's
 * `effective_reputation` view, which applies the time decay, rather than
 * `keeper_reputation`, which returns the stored score as it was at the
 * keeper's last action.
 */
async function readEffectiveReputation(
  session: Session,
  keeper: string,
): Promise<Reputation> {
  const raw = await session.client.read<RawReputation>("effective_reputation", [
    new Address(keeper).toScVal(),
  ]);
  return {
    scoreBps: Number(raw.score_bps),
    successes: Number(raw.successes),
    missedClaims: Number(raw.missed_claims),
  };
}

/** `skn keeper balance [--keeper <address>]`: reward balance, stake and effective reputation. */
export async function runKeeperBalance(
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, { keeper: { type: "string" } });
  if (positionals.length > 0) {
    throw new UsageError(`unexpected argument '${positionals[0]}'; usage: skn keeper balance [--keeper <address>]`);
  }
  const keeper = await keeperToLookUp(values, context);
  const session = await openReadOnly(values, context);

  const balance = await session.client.keeperBalance(keeper);
  const stake = await session.client.keeperStake(keeper);
  const unbonding = await session.client.pendingUnbond(keeper);

  // An older registry may not have the reputation view. That should not hide
  // the balance and stake, so it is reported as a warning instead.
  let reputation: Reputation | null = null;
  try {
    reputation = await readEffectiveReputation(session, keeper);
  } catch (err) {
    session.warnings.push(
      `could not read reputation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lines = [`Keeper ${keeper}`, `  balance:    ${balance}`, `  stake:      ${stake}`];
  let unbondingView: { amount: bigint; unlockLedger: number; ledgersRemaining: number } | null = null;
  if (unbonding !== undefined) {
    const now = (await session.server.getLatestLedger()).sequence;
    const remaining = Math.max(0, unbonding.unlockLedger - now);
    unbondingView = {
      amount: unbonding.amount,
      unlockLedger: unbonding.unlockLedger,
      ledgersRemaining: remaining,
    };
    lines.push(
      `  unbonding:  ${unbonding.amount}, ` +
        (remaining === 0
          ? `withdrawable now (unlocked at ledger ${unbonding.unlockLedger})`
          : `withdrawable at ledger ${unbonding.unlockLedger}, in ${describeWait(remaining)}`),
    );
  }
  lines.push(
    reputation === null
      ? "  reputation: unavailable"
      : `  reputation: ${(reputation.scoreBps / 100).toFixed(2)}% ` +
          `(${reputation.successes} executed, ${reputation.missedClaims} missed)`,
  );

  return finish(session, lines.join("\n"), {
    keeper,
    balance,
    stake,
    unbonding: unbondingView,
    reputation,
  });
}
