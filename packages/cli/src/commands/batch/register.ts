import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  MAX_CALLDATA_LEN,
  MAX_LOCK_LEDGERS,
  MIN_LOCK_LEDGERS,
  MIN_TTL_LEDGERS,
  keypairSigner,
  minReward as readMinReward,
} from "@soroban-keeper-network/sdk";
import {
  UsageError,
  loadConfig,
  parseCommandArgs,
  settingFlagsFrom,
  type CommandContext,
} from "../../args.js";
import { openRegistry } from "../../client.js";
import { resolveKey } from "../../keys.js";
import { jsonResult, ok, usage, type RunResult } from "../../output.js";
import { requireMainnetConfirmation, resolveSettings } from "../../settings.js";

/** Contract-side bounds mirrored for local pre-flight validation. */
export const CONTRACT_BOUNDS = {
  MAX_CALLDATA_LEN,
  MIN_LOCK_LEDGERS,
  MAX_LOCK_LEDGERS,
  MIN_TTL_LEDGERS,
} as const;

/** Fallback if `max_batch_size()` is unavailable. */
export const FALLBACK_MAX_BATCH_SIZE = 50;

/** `TaskType` variant names, in the contract's declaration order. */
export const TASK_TYPES = [
  "Liquidation",
  "OraclePricePush",
  "FundingRateUpdate",
  "LiquidityRebalance",
  "TtlExtension",
  "Custom",
] as const;

export type TaskTypeName = (typeof TASK_TYPES)[number];

export interface BatchTaskEntry {
  index: number;
  label: string;
  taskType: TaskTypeName;
  calldata: Uint8Array;
  reward: bigint;
  deadline: bigint;
  ttlLedgers: number;
  lockLedgers: number;
}

export interface BatchRegisterOptions {
  /** Clock in Unix seconds, injected for deterministic tests. */
  now?: (() => number) | undefined;
}

/**
 * `skn batch register <file> [--dry-run] [--buffer-bps <0..10000>]`:
 *
 * Ports `examples/batch-register` into the CLI so it shares config profiles,
 * key handling, and `--json` / human output formatting:
 *   1. Reads a task list from a JSON or CSV file.
 *   2. Validates every entry locally against the contract's own bounds,
 *      reporting all invalid entries at once.
 *   3. Reads `max_batch_size` and `min_reward` from the registry via read-only
 *      views (falling back to 50 and 0 if unavailable).
 *   4. Splits batches larger than `max_batch_size` into chunks automatically
 *      and computes each chunk's `max_total_reward` as the exact BigInt sum.
 *   5. With `--dry-run`, validates and prints the chunk plan without signing
 *      or submitting any transaction.
 */
export async function runBatchRegister(
  args: readonly string[],
  context: CommandContext,
  options: BatchRegisterOptions = {},
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {
    file: { type: "string" },
    from: { type: "string" },
    "dry-run": { type: "boolean" },
    "buffer-bps": { type: "string" },
  });
  const json = values.json === true;
  const dryRun = values["dry-run"] === true;

  if (positionals.length > 1) {
    return usage(
      `'skn batch register' takes a single task file path; got extra argument '${positionals[1]}'`,
      json,
    );
  }
  const taskFile =
    (values.file as string | undefined) ??
    (values.from as string | undefined) ??
    positionals[0];
  if (taskFile === undefined || taskFile.trim() === "") {
    return usage(
      "no task list given; pass a <tasks.json|tasks.csv> path or --file <path>",
      json,
    );
  }

  const rawBuffer =
    (values["buffer-bps"] as string | undefined) ??
    context.env["MAX_TOTAL_REWARD_BUFFER_BPS"] ??
    "0";
  const bufferBps = Number(rawBuffer);
  if (!/^\d+$/.test(rawBuffer) || !Number.isInteger(bufferBps) || bufferBps < 0 || bufferBps > 10_000) {
    return usage("buffer-bps must be an integer in [0, 10000]", json);
  }

  const entries = await parseTaskFile(taskFile);
  const config = await loadConfig(context);
  const settings = resolveSettings(settingFlagsFrom(values), config);

  if (!dryRun) {
    if (settings.contractId === undefined) {
      return usage("--contract-id is required (or set contractId in the selected profile)", json);
    }
    requireMainnetConfirmation(settings);
  }

  const key = await resolveKey(
    {
      keyFile: values["key-file"] as string | undefined,
      identity: values.identity as string | undefined,
    },
    { env: context.env, homeDir: context.homeDir, platform: context.platform },
  );
  if (!dryRun && key === undefined) {
    return usage("no signing key: set --key-file, --identity, or SKN_SECRET_KEY", json);
  }

  const warnings: string[] = [];
  let maxBatchSize = FALLBACK_MAX_BATCH_SIZE;
  let minReward = 0n;

  if (settings.contractId !== undefined) {
    const readClient = openRegistry(settings, context, warnings);
    try {
      const liveMax = await readClient.read<number | bigint | null | undefined>("max_batch_size");
      if (liveMax !== null && liveMax !== undefined && Number(liveMax) > 0) {
        maxBatchSize = Number(liveMax);
      }
    } catch {
      // Fallback to FALLBACK_MAX_BATCH_SIZE if view is unavailable on older deployments.
    }
    try {
      const liveMin = await readMinReward(readClient);
      minReward = liveMin;
    } catch {
      // Fallback to 0n if min_reward is unavailable.
    }
  }

  const nowSeconds = BigInt(
    options.now ? options.now() : Math.floor(Date.now() / 1000),
  );
  validateEntries(entries, nowSeconds, minReward);

  const chunks = chunkList(entries, maxBatchSize);
  const grandTotal = sumRewards(entries);

  if (dryRun) {
    const chunkReports = chunks.map((chunk, i) => ({
      chunkIndex: i + 1,
      totalChunks: chunks.length,
      entryCount: chunk.length,
      maxTotalReward: ceilingFor(chunk, bufferBps),
      entries: chunk.map((entry) => ({
        index: entry.index + 1,
        label: entry.label,
        taskType: entry.taskType,
        reward: entry.reward,
        deadline: entry.deadline,
        ttlLedgers: entry.ttlLedgers,
        lockLedgers: entry.lockLedgers,
        calldataBytes: entry.calldata.length,
      })),
    }));

    const stderr = warnings.map((line) => `skn: warning: ${line}\n`).join("");
    if (json) {
      const result = jsonResult({
        dryRun: true,
        submitted: false,
        network: settings.network,
        contractId: settings.contractId ?? null,
        maxBatchSize,
        totalEntries: entries.length,
        totalChunks: chunks.length,
        totalReward: grandTotal,
        bufferBps,
        chunks: chunkReports,
      });
      return { ...result, stderr };
    }

    const lines = [
      `batch register (dry-run) on ${settings.network}${settings.contractId ? ` (${settings.contractId})` : ""}`,
      `  task list:        ${taskFile} (${entries.length} entries)`,
      `  batch size limit: ${maxBatchSize} entries per call`,
      `  transactions:     ${chunks.length}`,
      `  total escrow:     ${grandTotal} stroops across all chunks`,
    ];
    if (bufferBps > 0) {
      lines.push(`  buffer bps:       ${bufferBps} bps above each chunk's sum`);
    }
    for (const report of chunkReports) {
      lines.push(
        `Chunk ${report.chunkIndex}/${report.totalChunks}: ${report.entryCount} entries, max_total_reward=${report.maxTotalReward}`,
      );
      for (const entry of report.entries) {
        lines.push(
          `  - ${entry.label}: ${entry.taskType}, reward=${entry.reward}, deadline=${entry.deadline}, calldata=${entry.calldataBytes}B`,
        );
      }
    }
    lines.push("Dry run complete -- nothing was submitted.");
    return { ...ok(`${lines.join("\n")}\n`), stderr };
  }

  // Real submission path: key and contractId are guaranteed present here.
  const keypair = Keypair.fromSecret((key as NonNullable<typeof key>).secret);
  const ownerAddress = keypair.publicKey();
  const signer = keypairSigner(keypair);
  const client = openRegistry(settings, context, warnings, { signer });

  const registered: { entry: BatchTaskEntry; taskId: bigint; chunkIndex: number }[] = [];
  const chunkSummaries: {
    chunkIndex: number;
    totalChunks: number;
    entryCount: number;
    maxTotalReward: bigint;
    taskIds: bigint[];
  }[] = [];
  const lines: string[] = [
    `batch register on ${settings.network} (${settings.contractId})`,
    `  owner:            ${ownerAddress}`,
    `  task list:        ${taskFile} (${entries.length} entries)`,
    `  batch size limit: ${maxBatchSize} entries per call`,
    `  transactions:     ${chunks.length}`,
    `  total escrow:     ${grandTotal} stroops across all chunks`,
  ];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] as BatchTaskEntry[];
    const ceiling = ceilingFor(chunk, bufferBps);
    lines.push(
      `Chunk ${i + 1}/${chunks.length}: ${chunk.length} entries, max_total_reward=${ceiling}`,
    );

    const rawTaskIds = await client.invoke<(bigint | number)[] | undefined>({
      method: "batch_register_tasks",
      source: ownerAddress,
      args: [
        nativeToScVal(ownerAddress, { type: "address" }),
        xdr.ScVal.scvVec(chunk.map(toBatchTaskParams)),
        nativeToScVal(ceiling, { type: "i128" }),
      ],
      signer,
    });

    const taskIds = Array.isArray(rawTaskIds)
      ? rawTaskIds.map((id) => BigInt(id))
      : chunk.map((_, j) => BigInt(registered.length + j + 1));

    chunkSummaries.push({
      chunkIndex: i + 1,
      totalChunks: chunks.length,
      entryCount: chunk.length,
      maxTotalReward: ceiling,
      taskIds,
    });

    taskIds.forEach((taskId, j) => {
      const entry = chunk[j];
      if (entry !== undefined) {
        registered.push({ entry, taskId, chunkIndex: i + 1 });
      }
    });
  }

  const stderr = warnings.map((line) => `skn: warning: ${line}\n`).join("");
  if (json) {
    const result = jsonResult({
      dryRun: false,
      submitted: true,
      network: settings.network,
      contractId: settings.contractId,
      owner: ownerAddress,
      maxBatchSize,
      totalEntries: entries.length,
      totalChunks: chunks.length,
      totalReward: grandTotal,
      chunks: chunkSummaries,
      tasks: registered.map(({ entry, taskId, chunkIndex }) => ({
        taskId,
        label: entry.label,
        taskType: entry.taskType,
        reward: entry.reward,
        deadline: entry.deadline,
        chunkIndex,
      })),
    });
    return { ...result, stderr };
  }

  lines.push("");
  lines.push("  Task id  Entry");
  for (const { entry, taskId } of registered) {
    lines.push(`  ${taskId.toString().padStart(7)}  ${entry.label}`);
  }
  lines.push("");
  lines.push(`Registered ${registered.length} task(s).`);
  return { ...ok(`${lines.join("\n")}\n`), stderr };
}

/**
 * Parses the task list from a JSON or CSV file. `.csv` is treated as CSV with
 * a header row, anything else as JSON.
 */
export async function parseTaskFile(taskFile: string): Promise<BatchTaskEntry[]> {
  let raw: string;
  try {
    raw = await readFile(taskFile, "utf8");
  } catch {
    throw new UsageError(`Task list not found: ${taskFile}`);
  }

  const isCsv = extname(taskFile).toLowerCase() === ".csv";
  const rows = isCsv ? parseCsv(raw) : parseJson(raw, taskFile);

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new UsageError(`${taskFile} contains no task entries.`);
  }
  return rows.map((row, i) => normalizeEntry(row, i, taskFile));
}

export function parseJson(raw: string, taskFile: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`${taskFile} is not valid JSON: ${(e as Error).message}`);
  }
  if (Array.isArray(parsed)) {
    return parsed as Record<string, unknown>[];
  }
  if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    return (parsed as { tasks: Record<string, unknown>[] }).tasks;
  }
  throw new UsageError(`${taskFile} contains no task entries.`);
}

/**
 * Minimal CSV reader matching `examples/batch-register`: header row,
 * comma-separated, optional double quotes, `""` as an escaped quote, `#`
 * comment lines and blank lines ignored.
 */
export function parseCsv(raw: string): Record<string, string>[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length < 2) {
    throw new UsageError("CSV needs a header row and at least one task row.");
  }

  const header = splitCsvLine(lines[0] as string);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    if (cells.length !== header.length) {
      throw new UsageError(
        `CSV row has ${cells.length} cells but the header has ${header.length}: ${line}`,
      );
    }
    return Object.fromEntries(header.map((key, i) => [key, cells[i] as string]));
  });
}

export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function normalizeEntry(
  row: Record<string, unknown>,
  index: number,
  taskFile: string,
): BatchTaskEntry {
  const where = `${taskFile} entry #${index + 1}`;

  const bigint = (field: string, value: unknown): bigint => {
    if (value === undefined || value === null || value === "") {
      throw new UsageError(`${where}: missing required field "${field}"`);
    }
    try {
      return BigInt(String(value).replace(/_/g, ""));
    } catch {
      throw new UsageError(`${where}: "${field}" is not an integer: ${String(value)}`);
    }
  };

  const integer = (field: string, value: unknown): number => {
    if (value === undefined || value === null || value === "") {
      throw new UsageError(`${where}: missing required field "${field}"`);
    }
    const n = Number(String(value).replace(/_/g, ""));
    if (!Number.isInteger(n)) {
      throw new UsageError(`${where}: "${field}" is not an integer: ${String(value)}`);
    }
    return n;
  };

  const rawTaskType = String(row["task_type"] ?? row["taskType"] ?? "");
  if (!(TASK_TYPES as readonly string[]).includes(rawTaskType)) {
    throw new UsageError(
      `${where}: unknown task_type "${rawTaskType}" — must be one of: ${TASK_TYPES.join(", ")}`,
    );
  }
  const taskType = rawTaskType as TaskTypeName;

  const calldataHex = String(row["calldata"] ?? "").replace(/^0x/i, "");
  if (calldataHex.length % 2 !== 0 || /[^0-9a-f]/i.test(calldataHex)) {
    throw new UsageError(`${where}: "calldata" must be a hex string (got: ${String(row["calldata"])})`);
  }

  const labelRaw = row["label"] ?? row["name"];
  const label =
    typeof labelRaw === "string" && labelRaw.trim() !== ""
      ? labelRaw.trim()
      : `entry #${index + 1}`;

  return {
    index,
    label,
    taskType,
    calldata: Buffer.from(calldataHex, "hex"),
    reward: bigint("reward", row["reward"]),
    deadline: bigint("deadline", row["deadline"]),
    ttlLedgers: integer("ttl_ledgers", row["ttl_ledgers"] ?? row["ttlLedgers"]),
    lockLedgers: integer("lock_ledgers", row["lock_ledgers"] ?? row["lockLedgers"]),
  };
}

/**
 * Validates every entry locally against the contract's own bounds and reports
 * all invalid entries at once.
 */
export function validateEntries(
  entries: readonly BatchTaskEntry[],
  nowSeconds: bigint,
  minReward: bigint,
): void {
  const problems: string[] = [];
  const note = (entry: BatchTaskEntry, message: string) =>
    problems.push(`  - ${entry.label} (entry #${entry.index + 1}): ${message}`);

  for (const entry of entries) {
    if (entry.reward <= 0n) {
      note(entry, `reward must be positive (got ${entry.reward})`);
    } else if (entry.reward < minReward) {
      note(
        entry,
        `reward ${entry.reward} is below the registry's min_reward ${minReward}`,
      );
    }
    if (entry.deadline <= nowSeconds) {
      note(
        entry,
        `deadline ${entry.deadline} is not in the future (ledger time is ${nowSeconds})`,
      );
    }
    if (entry.calldata.length > CONTRACT_BOUNDS.MAX_CALLDATA_LEN) {
      note(
        entry,
        `calldata is ${entry.calldata.length} bytes, over the ${CONTRACT_BOUNDS.MAX_CALLDATA_LEN}-byte limit`,
      );
    }
    if (
      entry.lockLedgers < CONTRACT_BOUNDS.MIN_LOCK_LEDGERS ||
      entry.lockLedgers > CONTRACT_BOUNDS.MAX_LOCK_LEDGERS
    ) {
      note(
        entry,
        `lock_ledgers ${entry.lockLedgers} is outside [${CONTRACT_BOUNDS.MIN_LOCK_LEDGERS}, ${CONTRACT_BOUNDS.MAX_LOCK_LEDGERS}]`,
      );
    }
    if (entry.ttlLedgers < CONTRACT_BOUNDS.MIN_TTL_LEDGERS) {
      note(
        entry,
        `ttl_ledgers ${entry.ttlLedgers} is below the minimum ${CONTRACT_BOUNDS.MIN_TTL_LEDGERS}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new UsageError(
      `${problems.length} invalid entr${problems.length === 1 ? "y" : "ies"} — the contract would reject the whole batch:\n${problems.join("\n")}`,
    );
  }
}

export function chunkList<T>(entries: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < entries.length; i += size) {
    chunks.push(entries.slice(i, i + size));
  }
  return chunks;
}

export function sumRewards(entries: readonly BatchTaskEntry[]): bigint {
  return entries.reduce((total, entry) => total + entry.reward, 0n);
}

export function ceilingFor(entries: readonly BatchTaskEntry[], bufferBps: number): bigint {
  const sum = sumRewards(entries);
  if (bufferBps === 0) return sum;
  return sum + (sum * BigInt(bufferBps)) / 10_000n;
}

/**
 * Encodes one entry as the contract's `BatchTaskParams` (`ScMap` with keys in
 * lexicographic order: `calldata`, `deadline`, `lock_ledgers`, `reward`,
 * `task_type`, `ttl_ledgers`).
 */
export function toBatchTaskParams(entry: BatchTaskEntry): xdr.ScVal {
  const field = (key: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: nativeToScVal(key, { type: "symbol" }), val });

  return xdr.ScVal.scvMap([
    field("calldata", nativeToScVal(Buffer.from(entry.calldata), { type: "bytes" })),
    field("deadline", nativeToScVal(entry.deadline, { type: "u64" })),
    field("lock_ledgers", nativeToScVal(entry.lockLedgers, { type: "u32" })),
    field("reward", nativeToScVal(entry.reward, { type: "i128" })),
    field(
      "task_type",
      xdr.ScVal.scvVec([nativeToScVal(entry.taskType, { type: "symbol" })]),
    ),
    field("ttl_ledgers", nativeToScVal(entry.ttlLedgers, { type: "u32" })),
  ]);
}
