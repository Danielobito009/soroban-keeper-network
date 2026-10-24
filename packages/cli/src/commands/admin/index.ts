import { Keypair, StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import {
  KeeperContractError,
  KeeperErrorCode,
  admin as readAdmin,
  disputeWindow as readDisputeWindow,
  feesAccrued as readFeesAccrued,
  getFeeBps,
  isPaused,
  keypairSigner,
  minReward as readMinReward,
  minStake as readMinStake,
  setDisputeWindow,
  setMinStake,
} from "@soroban-keeper-network/sdk";
import {
  UsageError,
  loadConfig,
  parseCommandArgs,
  settingFlagsFrom,
  type CommandContext,
} from "../../args.js";
import { openRegistry } from "../../client.js";
import type { ConfirmFn } from "../../confirm.js";
import { resolveKey } from "../../keys.js";
import { jsonResult, ok, usage, type RunResult } from "../../output.js";
import { requireMainnetConfirmation, resolveSettings } from "../../settings.js";

export const ADMIN_COMMANDS = [
  "pause",
  "unpause",
  "set-fee-bps",
  "set-min-reward",
  "set-min-stake",
  "set-dispute-window",
  "sweep-fees",
] as const;

export type AdminSubcommand = (typeof ADMIN_COMMANDS)[number];

export interface AdminCommandOptions {
  confirm?: ConfirmFn | undefined;
}

const MAX_FEE_BPS = 10_000;
const MAX_U32 = 4_294_967_295;

/**
 * Routes `skn admin <subcommand>`.
 *
 * Every admin command:
 *   1. Validates its arguments and checks `--confirm-mainnet` on mainnet.
 *   2. Verifies the signing key is the contract's current `admin()` before
 *      submitting anything.
 *   3. Reads the current on-chain value, prints both the current and new
 *      values, and requires confirmation (unless `--yes` is set).
 */
export async function runAdminCommand(
  subcommand: string | undefined,
  args: readonly string[],
  context: CommandContext,
  options: AdminCommandOptions = {},
): Promise<RunResult> {
  const json = args.includes("--json");
  if (subcommand === undefined || subcommand.startsWith("-")) {
    return usage(
      `'skn admin' needs a subcommand: ${ADMIN_COMMANDS.join(", ")}`,
      json,
    );
  }
  if (!isAdminSubcommand(subcommand)) {
    return usage(
      `unknown admin command '${subcommand}'; expected one of ${ADMIN_COMMANDS.join(", ")}`,
      json,
    );
  }

  const { values, positionals } = parseCommandArgs(args, {
    yes: { type: "boolean" },
    "fee-bps": { type: "string" },
    bps: { type: "string" },
    "min-reward": { type: "string" },
    "min-stake": { type: "string" },
    amount: { type: "string" },
    ledgers: { type: "string" },
    "dispute-window": { type: "string" },
    treasury: { type: "string" },
    to: { type: "string" },
  });
  const isJson = values.json === true;

  // Parse and validate command-specific arguments before touching the network.
  const parsedSpec = parseAdminSpec(subcommand, values, positionals);

  const config = await loadConfig(context);
  const settings = resolveSettings(settingFlagsFrom(values), config);
  if (settings.contractId === undefined) {
    return usage("--contract-id is required (or set contractId in the selected profile)", isJson);
  }
  requireMainnetConfirmation(settings);

  const key = await resolveKey(
    {
      keyFile: values["key-file"] as string | undefined,
      identity: values.identity as string | undefined,
    },
    { env: context.env, homeDir: context.homeDir, platform: context.platform },
  );
  if (key === undefined) {
    return usage("no signing key: set --key-file, --identity, or SKN_SECRET_KEY", isJson);
  }

  const keypair = Keypair.fromSecret(key.secret);
  const signerPublicKey = keypair.publicKey();
  const signer = keypairSigner(keypair);

  const warnings: string[] = [];
  const client = openRegistry(settings, context, warnings, { signer });

  // Verify the signer is the contract's configured admin BEFORE submitting.
  const currentAdmin = await readAdmin(client);
  if (currentAdmin === undefined) {
    throw new KeeperContractError(
      KeeperErrorCode.NotInitialized,
      `${subcommand} requires an initialized registry, but no admin is configured. Call initialize first.`,
      { local: true },
    );
  }
  if (currentAdmin !== signerPublicKey) {
    throw new KeeperContractError(
      KeeperErrorCode.Unauthorized,
      `signer ${signerPublicKey} is not the contract admin (${currentAdmin}).`,
      { local: true },
    );
  }

  // Read the current value, compute the new value, and prepare the execution plan.
  const plan = await buildExecutionPlan(client, signerPublicKey, settings.treasuryContractId, parsedSpec);

  const summaryLines = [
    `admin ${subcommand} on ${settings.network} (${settings.contractId})`,
    `  admin:   ${signerPublicKey}`,
    `  current: ${plan.currentDisplay}`,
    `  new:     ${plan.newDisplay}`,
  ];
  const summary = summaryLines.join("\n");

  if (!values.yes) {
    if (options.confirm === undefined) {
      return usage(
        `not submitted: confirmation required for 'skn admin ${subcommand}' (current: ${plan.currentDisplay}, new: ${plan.newDisplay}); pass --yes to confirm`,
        isJson,
      );
    }
    const confirmed = await options.confirm(
      `${summary}\nConfirm 'skn admin ${subcommand}'? [y/N] `,
    );
    if (!confirmed) {
      if (isJson) {
        return jsonResult({
          submitted: false,
          command: subcommand,
          contractId: settings.contractId,
          network: settings.network,
          admin: signerPublicKey,
          current: plan.currentRaw,
          next: plan.newRaw,
          previousValue: plan.currentRaw,
          newValue: plan.newRaw,
          ...plan.extraJson,
        });
      }
      return ok(`${summary}\nnot submitted\n`);
    }
  }

  await plan.execute();

  const stderr = warnings.map((line) => `skn: warning: ${line}\n`).join("");
  if (isJson) {
    const result = jsonResult({
      submitted: true,
      command: subcommand,
      contractId: settings.contractId,
      network: settings.network,
      admin: signerPublicKey,
      current: plan.currentRaw,
      next: plan.newRaw,
      previousValue: plan.currentRaw,
      newValue: plan.newRaw,
      ...plan.extraJson,
    });
    return { ...result, stderr };
  }

  return {
    ...ok(`${summary}\nsubmitted: ${ plan.fieldLabel } ${plan.currentDisplay} -> ${plan.newDisplay}\n`),
    stderr,
  };
}

function isAdminSubcommand(value: string): value is AdminSubcommand {
  return (ADMIN_COMMANDS as readonly string[]).includes(value);
}

type AdminSpec =
  | { kind: "pause" }
  | { kind: "unpause" }
  | { kind: "set-fee-bps"; newBps: number }
  | { kind: "set-min-reward"; minReward: bigint }
  | { kind: "set-min-stake"; minStake: bigint }
  | { kind: "set-dispute-window"; ledgers: number }
  | { kind: "sweep-fees"; treasury: string | undefined; amount: bigint };

function parseAdminSpec(
  subcommand: AdminSubcommand,
  values: Record<string, string | boolean | undefined>,
  positionals: string[],
): AdminSpec {
  switch (subcommand) {
    case "pause": {
      if (positionals.length > 0) {
        throw new UsageError(`'skn admin pause' takes no positional arguments; got '${positionals[0]}'`);
      }
      return { kind: "pause" };
    }
    case "unpause": {
      if (positionals.length > 0) {
        throw new UsageError(`'skn admin unpause' takes no positional arguments; got '${positionals[0]}'`);
      }
      return { kind: "unpause" };
    }
    case "set-fee-bps": {
      if (positionals.length > 1) {
        throw new UsageError(`'skn admin set-fee-bps' takes one basis-points value; got '${positionals[1]}'`);
      }
      const raw =
        (values["fee-bps"] as string | undefined) ??
        (values.bps as string | undefined) ??
        positionals[0];
      if (raw === undefined) {
        throw new UsageError("'skn admin set-fee-bps' requires a basis-points value (0..10000)");
      }
      const cleaned = raw.replace(/_/g, "");
      const newBps = Number(cleaned);
      if (!/^\d+$/.test(cleaned) || !Number.isInteger(newBps) || newBps < 0 || newBps > MAX_FEE_BPS) {
        throw new KeeperContractError(
          KeeperErrorCode.InvalidFeeBps,
          `fee bps must be an integer between 0 and ${MAX_FEE_BPS}, got '${raw}'.`,
          { local: true },
        );
      }
      return { kind: "set-fee-bps", newBps };
    }
    case "set-min-reward": {
      if (positionals.length > 1) {
        throw new UsageError(`'skn admin set-min-reward' takes one amount; got '${positionals[1]}'`);
      }
      const raw =
        (values["min-reward"] as string | undefined) ??
        (values.amount as string | undefined) ??
        positionals[0];
      if (raw === undefined) {
        throw new UsageError("'skn admin set-min-reward' requires a minimum reward in stroops");
      }
      const minReward = parseNonNegativeBigInt(raw, "min-reward");
      return { kind: "set-min-reward", minReward };
    }
    case "set-min-stake": {
      if (positionals.length > 1) {
        throw new UsageError(`'skn admin set-min-stake' takes one amount; got '${positionals[1]}'`);
      }
      const raw =
        (values["min-stake"] as string | undefined) ??
        (values.amount as string | undefined) ??
        positionals[0];
      if (raw === undefined) {
        throw new UsageError("'skn admin set-min-stake' requires a minimum stake in stroops");
      }
      const minStake = parseNonNegativeBigInt(raw, "min-stake");
      return { kind: "set-min-stake", minStake };
    }
    case "set-dispute-window": {
      if (positionals.length > 1) {
        throw new UsageError(`'skn admin set-dispute-window' takes one ledger count; got '${positionals[1]}'`);
      }
      const raw =
        (values.ledgers as string | undefined) ??
        (values["dispute-window"] as string | undefined) ??
        positionals[0];
      if (raw === undefined) {
        throw new UsageError("'skn admin set-dispute-window' requires a ledger count");
      }
      const cleaned = raw.replace(/_/g, "");
      const ledgers = Number(cleaned);
      if (!/^\d+$/.test(cleaned) || !Number.isInteger(ledgers) || ledgers < 0 || ledgers > MAX_U32) {
        throw new UsageError(
          `dispute window ledgers must be an integer between 0 and ${MAX_U32}; got '${raw}'`,
        );
      }
      return { kind: "set-dispute-window", ledgers };
    }
    case "sweep-fees": {
      if (positionals.length > 2) {
        throw new UsageError(`'skn admin sweep-fees' takes at most <treasury> and <amount>; got '${positionals[2]}'`);
      }
      const flagTreasury =
        (values.treasury as string | undefined) ?? (values.to as string | undefined);
      const flagAmount = values.amount as string | undefined;

      let treasuryAddr: string | undefined;
      let rawAmount: string | undefined;

      if (flagTreasury !== undefined) {
        treasuryAddr = flagTreasury;
        rawAmount = flagAmount ?? positionals[0];
      } else if (positionals.length === 2) {
        treasuryAddr = positionals[0];
        rawAmount = flagAmount ?? positionals[1];
      } else if (positionals.length === 1) {
        // Could be `<amount>` when treasury comes from profile, or `<treasury>` when `--amount` is given.
        if (flagAmount !== undefined) {
          treasuryAddr = positionals[0];
          rawAmount = flagAmount;
        } else {
          rawAmount = positionals[0];
        }
      } else {
        rawAmount = flagAmount;
      }

      if (rawAmount === undefined) {
        throw new UsageError(
          "'skn admin sweep-fees' requires --amount <stroops> (and --treasury <address> or a profile treasuryContractId)",
        );
      }
      const amount = parsePositiveBigInt(rawAmount, "amount");
      return { kind: "sweep-fees", treasury: treasuryAddr, amount };
    }
  }
}

function parseNonNegativeBigInt(raw: string, label: string): bigint {
  const cleaned = raw.replace(/_/g, "");
  if (!/^-?\d+$/.test(cleaned)) {
    throw new UsageError(`${label} must be an integer in stroops; got '${raw}'`);
  }
  const value = BigInt(cleaned);
  if (value < 0n) {
    throw new KeeperContractError(
      KeeperErrorCode.InvalidReward,
      `${label} must not be negative, got ${value}.`,
      { local: true },
    );
  }
  return value;
}

function parsePositiveBigInt(raw: string, label: string): bigint {
  const cleaned = raw.replace(/_/g, "");
  if (!/^-?\d+$/.test(cleaned)) {
    throw new UsageError(`${label} must be a positive integer in stroops; got '${raw}'`);
  }
  const value = BigInt(cleaned);
  if (value <= 0n) {
    throw new KeeperContractError(
      KeeperErrorCode.InvalidReward,
      `${label} must be a positive number of token units, got ${value}.`,
      { local: true },
    );
  }
  return value;
}

interface ExecutionPlan {
  fieldLabel: string;
  currentDisplay: string;
  newDisplay: string;
  currentRaw: unknown;
  newRaw: unknown;
  extraJson: Record<string, unknown>;
  execute: () => Promise<void>;
}

async function buildExecutionPlan(
  client: ReturnType<typeof openRegistry>,
  adminAddress: string,
  profileTreasuryId: string | undefined,
  spec: AdminSpec,
): Promise<ExecutionPlan> {
  switch (spec.kind) {
    case "pause": {
      const current = await isPaused(client);
      return {
        fieldLabel: "paused",
        currentDisplay: `paused = ${current}`,
        newDisplay: "paused = true",
        currentRaw: current,
        newRaw: true,
        extraJson: {},
        execute: () =>
          client.invoke<void>({
            method: "pause",
            source: adminAddress,
            args: [nativeToScVal(adminAddress, { type: "address" })],
          }),
      };
    }
    case "unpause": {
      const current = await isPaused(client);
      return {
        fieldLabel: "paused",
        currentDisplay: `paused = ${current}`,
        newDisplay: "paused = false",
        currentRaw: current,
        newRaw: false,
        extraJson: {},
        execute: () =>
          client.invoke<void>({
            method: "unpause",
            source: adminAddress,
            args: [nativeToScVal(adminAddress, { type: "address" })],
          }),
      };
    }
    case "set-fee-bps": {
      const current = await getFeeBps(client);
      return {
        fieldLabel: "fee_bps",
        currentDisplay: `${current} bps (${(current / 100).toFixed(2)}%)`,
        newDisplay: `${spec.newBps} bps (${(spec.newBps / 100).toFixed(2)}%)`,
        currentRaw: current,
        newRaw: spec.newBps,
        extraJson: {},
        execute: () =>
          client.invoke<void>({
            method: "set_fee_bps",
            source: adminAddress,
            args: [
              nativeToScVal(adminAddress, { type: "address" }),
              nativeToScVal(spec.newBps, { type: "u32" }),
            ],
          }),
      };
    }
    case "set-min-reward": {
      const current = await readBigIntOrZero(() => readMinReward(client));
      return {
        fieldLabel: "min_reward",
        currentDisplay: `${current} stroops`,
        newDisplay: `${spec.minReward} stroops`,
        currentRaw: current,
        newRaw: spec.minReward,
        extraJson: {},
        execute: () =>
          client.invoke<void>({
            method: "set_min_reward",
            source: adminAddress,
            args: [
              nativeToScVal(adminAddress, { type: "address" }),
              nativeToScVal(spec.minReward, { type: "i128" }),
            ],
          }),
      };
    }
    case "set-min-stake": {
      const current = await readBigIntOrZero(() => readMinStake(client));
      return {
        fieldLabel: "min_stake",
        currentDisplay: `${current} stroops`,
        newDisplay: `${spec.minStake} stroops`,
        currentRaw: current,
        newRaw: spec.minStake,
        extraJson: {},
        execute: () => setMinStake(client, { admin: adminAddress, minStake: spec.minStake }),
      };
    }
    case "set-dispute-window": {
      const current = await readDisputeWindow(client);
      return {
        fieldLabel: "dispute_window",
        currentDisplay: `${current} ledgers`,
        newDisplay: `${spec.ledgers} ledgers`,
        currentRaw: current,
        newRaw: spec.ledgers,
        extraJson: {},
        execute: () => setDisputeWindow(client, { admin: adminAddress, ledgers: spec.ledgers }),
      };
    }
    case "sweep-fees": {
      const treasuryAddress = spec.treasury ?? profileTreasuryId;
      if (treasuryAddress === undefined) {
        throw new UsageError(
          "--treasury <address> is required (or set treasuryContractId in the selected profile)",
        );
      }
      if (
        !StrKey.isValidEd25519PublicKey(treasuryAddress) &&
        !StrKey.isValidContract(treasuryAddress)
      ) {
        throw new UsageError(
          `treasury must be a valid Stellar account (G...) or contract (C...) address; got '${treasuryAddress}'`,
        );
      }
      const accrued = await readBigIntOrZero(() => readFeesAccrued(client));
      if (spec.amount > accrued) {
        throw new KeeperContractError(
          KeeperErrorCode.NoRewardsAvailable,
          `amount ${spec.amount} exceeds the ${accrued} currently accrued in protocol fees.`,
          { local: true },
        );
      }
      const remaining = accrued - spec.amount;
      return {
        fieldLabel: "fees_accrued",
        currentDisplay: `${accrued} stroops accrued`,
        newDisplay: `${remaining} stroops accrued (sweeping ${spec.amount} stroops to ${treasuryAddress})`,
        currentRaw: accrued,
        newRaw: remaining,
        extraJson: {
          treasury: treasuryAddress,
          amount: spec.amount,
        },
        execute: () =>
          client.invoke<void>({
            method: "sweep_fees",
            source: adminAddress,
            args: [
              nativeToScVal(adminAddress, { type: "address" }),
              nativeToScVal(treasuryAddress, { type: "address" }),
              nativeToScVal(spec.amount, { type: "i128" }),
            ],
          }),
      };
    }
  }
}

async function readBigIntOrZero(readFn: () => Promise<bigint>): Promise<bigint> {
  try {
    return await readFn();
  } catch (err) {
    if (err instanceof TypeError) return 0n;
    throw err;
  }
}
