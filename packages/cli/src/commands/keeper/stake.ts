import { KeeperErrorCode } from "@soroban-keeper-network/sdk";
import { parseCommandArgs, type CommandContext } from "../../args.js";
import { explainContractError } from "../../errors.js";
import { EXIT } from "../../exitCodes.js";
import { fail, type RunResult } from "../../output.js";
import {
  SECONDS_PER_LEDGER,
  describeWait,
  expectPositionals,
  parsePositiveAmount,
} from "../parse.js";
import {
  finish,
  isRunResult,
  openReadOnly,
  openSigned,
  requireMainnetConfirmation,
} from "../session.js";
import { keeperToLookUp } from "./target.js";

/** When a ledger will close, estimated from how far away it is. */
function estimateTime(ledgersAway: number, nowMs = Date.now()): string {
  return new Date(nowMs + ledgersAway * SECONDS_PER_LEDGER * 1000).toISOString();
}

/** `skn keeper stake <amount>`: deposits collateral. */
export async function runKeeperStake(
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {});
  expectPositionals(positionals, 1, "skn keeper stake <amount>");
  const amount = parsePositiveAmount(positionals[0], "amount");

  const session = await openSigned(values, context);
  if (isRunResult(session)) return session;
  requireMainnetConfirmation(session.settings);

  await session.client.stakeDeposit({ keeper: session.address, amount, signer: session.signer });
  const stake = await session.client.keeperStake(session.address);
  return finish(session, `Staked ${amount}. Bonded stake is now ${stake}.`, {
    action: "stake",
    keeper: session.address,
    staked: amount,
    stake,
  });
}

/**
 * `skn keeper unbond <amount>`: starts the unbonding delay and says when the
 * stake can be withdrawn.
 */
export async function runKeeperUnbond(
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {});
  expectPositionals(positionals, 1, "skn keeper unbond <amount>");
  const amount = parsePositiveAmount(positionals[0], "amount");

  const session = await openSigned(values, context);
  if (isRunResult(session)) return session;
  requireMainnetConfirmation(session.settings);

  await session.client.initiateUnbond({ keeper: session.address, amount, signer: session.signer });

  const request = await session.client.pendingUnbond(session.address);
  const now = (await session.server.getLatestLedger()).sequence;
  const unlockLedger = request?.unlockLedger ?? now;
  const remaining = Math.max(0, unlockLedger - now);
  const when = estimateTime(remaining);
  return finish(
    session,
    [
      `Started unbonding ${amount}.`,
      `  withdrawable at ledger ${unlockLedger}, in ${describeWait(remaining)}`,
      `  about ${when}`,
      "Run 'skn keeper withdraw-stake' after that.",
    ].join("\n"),
    {
      action: "unbond",
      keeper: session.address,
      amount,
      unlockLedger,
      ledgersRemaining: remaining,
      estimatedUnlockTime: when,
    },
  );
}

/**
 * `skn keeper withdraw-stake`: releases the pending unbond. Before the unlock
 * ledger it explains the wait and sends nothing.
 */
export async function runKeeperWithdrawStake(
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {});
  expectPositionals(positionals, 0, "skn keeper withdraw-stake");
  const json = values.json === true;

  const session = await openSigned(values, context);
  if (isRunResult(session)) return session;

  const request = await session.client.pendingUnbond(session.address);
  if (request === undefined) {
    const help = explainContractError(KeeperErrorCode.NoPendingUnbond);
    return fail(EXIT.contract, "CONTRACT_ERROR", `${help.name}: ${help.message}`, json, {
      contractError: help.name,
      errorCode: KeeperErrorCode.NoPendingUnbond,
      hint: help.hint,
    });
  }

  const now = (await session.server.getLatestLedger()).sequence;
  if (now < request.unlockLedger) {
    const remaining = request.unlockLedger - now;
    return fail(
      EXIT.contract,
      "CONTRACT_ERROR",
      `UnbondNotReady: ${request.amount} is still unbonding. It becomes withdrawable at ledger ${request.unlockLedger}, ` +
        `in ${describeWait(remaining)} (about ${estimateTime(remaining)}). Nothing was sent.`,
      json,
      {
        contractError: "UnbondNotReady",
        errorCode: KeeperErrorCode.UnbondNotReady,
        unlockLedger: request.unlockLedger,
        ledgersRemaining: remaining,
        hint: "Run this again after the unlock ledger.",
      },
    );
  }

  requireMainnetConfirmation(session.settings);
  const released = await session.client.withdrawStake({
    keeper: session.address,
    signer: session.signer,
  });
  return finish(session, `Withdrew ${released} of stake to ${session.address}.`, {
    action: "withdraw-stake",
    keeper: session.address,
    withdrawn: released,
  });
}

/**
 * `skn keeper unbonding [--keeper <address>]`: the pending-unbond view.
 */
export async function runKeeperUnbonding(
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, { keeper: { type: "string" } });
  expectPositionals(positionals, 0, "skn keeper unbonding [--keeper <address>]");
  const keeper = await keeperToLookUp(values, context);
  const session = await openReadOnly(values, context);

  const request = await session.client.pendingUnbond(keeper);
  if (request === undefined) {
    return finish(session, `Keeper ${keeper} has no unbond request pending.`, {
      keeper,
      unbonding: null,
    });
  }
  const now = (await session.server.getLatestLedger()).sequence;
  const remaining = Math.max(0, request.unlockLedger - now);
  const text =
    remaining === 0
      ? `Keeper ${keeper}: ${request.amount} is withdrawable now (unlocked at ledger ${request.unlockLedger}).`
      : `Keeper ${keeper}: ${request.amount} is unbonding. Withdrawable at ledger ${request.unlockLedger}, ` +
        `in ${describeWait(remaining)} (about ${estimateTime(remaining)}).`;
  return finish(session, text, {
    keeper,
    unbonding: {
      amount: request.amount,
      unlockLedger: request.unlockLedger,
      ledgersRemaining: remaining,
      withdrawable: remaining === 0,
    },
  });
}
