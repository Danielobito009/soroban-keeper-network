import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type RunOptions } from "../src/cli.js";
import { EXIT } from "../src/exitCodes.js";
import { CONTRACT_ID, TEST_PUBLIC, TEST_SECRET, scratchDir } from "./support/env.js";
import { FakeRpc } from "./support/fakeRpc.js";

let dir: string;
let cleanup: () => Promise<void>;
const FIXED_NOW = 1_700_000_000;

beforeEach(async () => {
  ({ dir, cleanup } = await scratchDir());
});

afterEach(async () => {
  await cleanup();
});

function batchOptions(server: FakeRpc, withKey = true): RunOptions {
  return {
    server,
    env: {
      SKN_CONFIG: join(dir, "skn.config.json"),
      ...(withKey ? { SKN_SECRET_KEY: TEST_SECRET } : {}),
    },
    homeDir: dir,
    platform: "linux",
    now: () => FIXED_NOW,
  };
}

describe("skn batch register (#703)", () => {
  it("validates and prints chunks in --dry-run mode without requiring a key or submitting", async () => {
    const file = join(dir, "tasks.json");
    await writeFile(
      file,
      JSON.stringify({
        tasks: [
          {
            label: "liquidate-position-1041",
            task_type: "Liquidation",
            calldata: "6c6971756964617465",
            reward: "1_000_000",
            deadline: "1790000000",
            ttl_ledgers: 17280,
            lock_ledgers: 120,
          },
          {
            label: "push-xlm-usd-price",
            task_type: "OraclePricePush",
            calldata: "0x786c6d",
            reward: "500000",
            deadline: "1790000000",
            ttl_ledgers: 17280,
            lock_ledgers: 60,
          },
        ],
      }),
      "utf8",
    );
    const server = new FakeRpc();

    const result = await run(
      ["batch", "register", file, "--dry-run"],
      batchOptions(server, false),
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("Chunk 1/1: 2 entries, max_total_reward=1500000");
    expect(result.stdout).toContain("liquidate-position-1041: Liquidation, reward=1000000");
    expect(result.stdout).toContain("push-xlm-usd-price: OraclePricePush, reward=500000");
    expect(result.stdout).toContain("Dry run complete -- nothing was submitted.");
    expect(server.submitted).toHaveLength(0);
  });

  it("accepts CSV format with comments, blank lines, and quoted cells", async () => {
    const file = join(dir, "tasks.csv");
    const csv = [
      "# Sample batch CSV",
      "",
      "label,task_type,calldata,reward,deadline,ttl_ledgers,lock_ledgers",
      '"liquidate ""alpha""",Liquidation,deadbeef,1000000,1790000000,17280,120',
      "rebalance-pool,LiquidityRebalance,,2500000,1790000000,5000,100",
    ].join("\n");
    await writeFile(file, csv, "utf8");

    const server = new FakeRpc({
      results: {
        max_batch_size: 50,
        min_reward: 100_000n,
        batch_register_tasks: [41n, 42n],
      },
    });

    const result = await run(
      ["batch", "register", file, "--contract-id", CONTRACT_ID],
      batchOptions(server),
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("Chunk 1/1: 2 entries, max_total_reward=3500000");
    expect(result.stdout).toContain('41  liquidate "alpha"');
    expect(result.stdout).toContain("42  rebalance-pool");
    expect(result.stdout).toContain("Registered 2 task(s).");
    expect(server.submitted).toHaveLength(1);
  });

  it("splits batches larger than max_batch_size automatically and reports per chunk", async () => {
    const file = join(dir, "five-tasks.json");
    const entries = Array.from({ length: 5 }, (_, i) => ({
      label: `task-${i + 1}`,
      task_type: "Custom",
      calldata: "aa",
      reward: String((i + 1) * 100_000),
      deadline: "1790000000",
      ttl_ledgers: 2000,
      lock_ledgers: 50,
    }));
    await writeFile(file, JSON.stringify(entries), "utf8");

    const server = new FakeRpc({
      results: {
        max_batch_size: 2,
        min_reward: 0n,
        batch_register_tasks: (args: unknown[]) => {
          const maxTotal = args[2] as bigint;
          if (maxTotal === 300_000n) return [101n, 102n];
          if (maxTotal === 700_000n) return [103n, 104n];
          return [105n];
        },
      },
    });

    const result = await run(
      ["batch", "register", file, "--contract-id", CONTRACT_ID, "--json"],
      batchOptions(server),
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(server.submitted).toHaveLength(3);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.maxBatchSize).toBe(2);
    expect(parsed.totalEntries).toBe(5);
    expect(parsed.totalChunks).toBe(3);
    expect(parsed.totalReward).toBe("1500000");
    expect(parsed.owner).toBe(TEST_PUBLIC);
    expect(parsed.chunks).toEqual([
      {
        chunkIndex: 1,
        totalChunks: 3,
        entryCount: 2,
        maxTotalReward: "300000",
        taskIds: ["101", "102"],
      },
      {
        chunkIndex: 2,
        totalChunks: 3,
        entryCount: 2,
        maxTotalReward: "700000",
        taskIds: ["103", "104"],
      },
      {
        chunkIndex: 3,
        totalChunks: 3,
        entryCount: 1,
        maxTotalReward: "500000",
        taskIds: ["105"],
      },
    ]);
  });

  it("reports all invalid entries at once during local pre-flight validation without submitting", async () => {
    const file = join(dir, "bad.json");
    await writeFile(
      file,
      JSON.stringify([
        {
          label: "bad-reward",
          task_type: "Liquidation",
          calldata: "",
          reward: "0",
          deadline: "1790000000",
          ttl_ledgers: 17280,
          lock_ledgers: 120,
        },
        {
          label: "past-deadline",
          task_type: "Custom",
          calldata: "",
          reward: "1000000",
          deadline: String(FIXED_NOW - 10),
          ttl_ledgers: 500,
          lock_ledgers: 5,
        },
      ]),
      "utf8",
    );
    const server = new FakeRpc({
      results: {
        max_batch_size: 50,
        min_reward: 1_000n,
      },
    });

    const result = await run(
      ["batch", "register", file, "--contract-id", CONTRACT_ID],
      batchOptions(server),
    );

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("4 invalid entries");
    expect(result.stderr).toContain("bad-reward (entry #1): reward must be positive");
    expect(result.stderr).toContain("past-deadline (entry #2): deadline");
    expect(result.stderr).toContain("lock_ledgers 5 is outside [12, 17280]");
    expect(result.stderr).toContain("ttl_ledgers 500 is below the minimum 1000");
    expect(server.submitted).toHaveLength(0);
  });
});
