import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type RunOptions } from "../src/cli.js";
import { EXIT } from "../src/exitCodes.js";
import {
  CONTRACT_ID,
  OTHER_PUBLIC,
  OTHER_SECRET,
  TEST_PUBLIC,
  TEST_SECRET,
  TREASURY_ID,
  scratchDir,
} from "./support/env.js";
import { FakeRpc } from "./support/fakeRpc.js";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await scratchDir());
});

afterEach(async () => {
  await cleanup();
});

function adminOptions(
  server: FakeRpc,
  secret: string = TEST_SECRET,
  confirm?: (question: string) => Promise<boolean>,
): RunOptions {
  return {
    server,
    env: {
      SKN_CONFIG: join(dir, "skn.config.json"),
      SKN_SECRET_KEY: secret,
    },
    homeDir: dir,
    platform: "linux",
    confirm,
  };
}

describe("skn admin command group (#702)", () => {
  it("refuses to run before submitting when the signer is not the contract admin", async () => {
    const server = new FakeRpc({
      results: {
        admin: TEST_PUBLIC,
        is_paused: false,
      },
    });
    let confirmCalled = false;

    const result = await run(
      ["admin", "pause", "--contract-id", CONTRACT_ID],
      adminOptions(server, OTHER_SECRET, async () => {
        confirmCalled = true;
        return true;
      }),
    );

    expect(result.exitCode).toBe(EXIT.contract);
    expect(result.stderr).toContain("Unauthorized");
    expect(result.stderr).toContain(OTHER_PUBLIC);
    expect(result.stderr).toContain(TEST_PUBLIC);
    expect(result.stderr).not.toContain(OTHER_SECRET);
    expect(confirmCalled).toBe(false);
    expect(server.submitted).toHaveLength(0);
    // Only the read-only admin() check ran; pause was never simulated or submitted.
    expect(server.calls.map((c) => c.method)).toEqual(["admin"]);
  });

  it("refuses when the registry is not initialized (no admin configured)", async () => {
    const server = new FakeRpc({
      results: {
        admin: null,
      },
    });

    const result = await run(
      ["admin", "pause", "--contract-id", CONTRACT_ID, "--yes", "--json"],
      adminOptions(server),
    );

    expect(result.exitCode).toBe(EXIT.contract);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error.contractError).toBe("NotInitialized");
    expect(server.submitted).toHaveLength(0);
  });

  it("shows current and new values in confirmation prompt and cancels when declined", async () => {
    const server = new FakeRpc({
      results: {
        admin: TEST_PUBLIC,
        get_fee_bps: 300,
      },
    });
    const prompts: string[] = [];

    const result = await run(
      ["admin", "set-fee-bps", "500", "--contract-id", CONTRACT_ID],
      adminOptions(server, TEST_SECRET, async (question) => {
        prompts.push(question);
        return false;
      }),
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("current: 300 bps (3.00%)");
    expect(prompts[0]).toContain("new:     500 bps (5.00%)");
    expect(result.stdout).toContain("not submitted");
    expect(server.submitted).toHaveLength(0);
  });

  it("requires confirmation when stdin is not a TTY and --yes is omitted", async () => {
    const server = new FakeRpc({
      results: {
        admin: TEST_PUBLIC,
        is_paused: false,
      },
    });

    const result = await run(
      ["admin", "pause", "--contract-id", CONTRACT_ID],
      adminOptions(server, TEST_SECRET, undefined),
    );

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("confirmation required");
    expect(result.stderr).toContain("current: paused = false");
    expect(result.stderr).toContain("new: paused = true");
    expect(server.submitted).toHaveLength(0);
  });

  it("executes 'skn admin pause' and 'skn admin unpause' when confirmed", async () => {
    const pauseServer = new FakeRpc({
      results: {
        admin: TEST_PUBLIC,
        is_paused: false,
        pause: null,
      },
    });

    const pauseRes = await run(
      ["admin", "pause", "--contract-id", CONTRACT_ID],
      adminOptions(pauseServer, TEST_SECRET, async () => true),
    );

    expect(pauseRes.exitCode).toBe(EXIT.ok);
    expect(pauseRes.stdout).toContain("current: paused = false");
    expect(pauseRes.stdout).toContain("new:     paused = true");
    expect(pauseServer.submitted).toHaveLength(1);
    expect(pauseServer.calls.map((c) => c.method)).toEqual(["admin", "is_paused", "pause"]);

    const unpauseServer = new FakeRpc({
      results: {
        admin: TEST_PUBLIC,
        is_paused: true,
        unpause: null,
      },
    });

    const unpauseRes = await run(
      ["admin", "unpause", "--contract-id", CONTRACT_ID, "--yes", "--json"],
      adminOptions(unpauseServer),
    );

    expect(unpauseRes.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(unpauseRes.stdout)).toMatchObject({
      submitted: true,
      command: "unpause",
      current: true,
      next: false,
      previousValue: true,
      newValue: false,
    });
    expect(unpauseServer.submitted).toHaveLength(1);
  });

  it("executes 'skn admin set-fee-bps', 'set-min-reward', 'set-min-stake', and 'set-dispute-window'", async () => {
    const feeServer = new FakeRpc({
      results: {
        admin: TEST_PUBLIC,
        get_fee_bps: 300,
        set_fee_bps: null,
      },
    });
    const feeRes = await run(
      ["admin", "set-fee-bps", "450", "--contract-id", CONTRACT_ID, "--yes", "--json"],
      adminOptions(feeServer),
    );
    expect(feeRes.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(feeRes.stdout)).toMatchObject({
      submitted: true,
      command: "set-fee-bps",
      current: 300,
      next: 450,
    });
    expect(feeServer.calls.at(-1)?.args).toEqual([TEST_PUBLIC, 450]);

    const rewardServer = new FakeRpc({
      results: {
        admin: TEST_PUBLIC,
        min_reward: 1_000_000n,
        set_min_reward: null,
      },
    });
    const rewardRes = await run(
      ["admin", "set-min-reward", "2_500_000", "--contract-id", CONTRACT_ID, "--yes", "--json"],
      adminOptions(rewardServer),
    );
    expect(rewardRes.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(rewardRes.stdout)).toMatchObject({
      submitted: true,
      command: "set-min-reward",
      current: "1000000",
      next: "2500000",
    });
    expect(rewardServer.calls.at(-1)?.args).toEqual([TEST_PUBLIC, 2_500_000n]);

    const stakeServer = new FakeRpc({
      results: {
        admin: TEST_PUBLIC,
        min_stake: 10_000_000n,
        set_min_stake: null,
      },
    });
    const stakeRes = await run(
      ["admin", "set-min-stake", "50_000_000", "--contract-id", CONTRACT_ID, "--yes", "--json"],
      adminOptions(stakeServer),
    );
    expect(stakeRes.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(stakeRes.stdout)).toMatchObject({
      submitted: true,
      command: "set-min-stake",
      current: "10000000",
      next: "50000000",
    });
    expect(stakeServer.calls.at(-1)?.args).toEqual([TEST_PUBLIC, 50_000_000n]);

    const windowServer = new FakeRpc({
      results: {
        admin: TEST_PUBLIC,
        dispute_window: 0,
        set_dispute_window: null,
      },
    });
    const windowRes = await run(
      ["admin", "set-dispute-window", "720", "--contract-id", CONTRACT_ID, "--yes", "--json"],
      adminOptions(windowServer),
    );
    expect(windowRes.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(windowRes.stdout)).toMatchObject({
      submitted: true,
      command: "set-dispute-window",
      current: 0,
      next: 720,
    });
    expect(windowServer.calls.at(-1)?.args).toEqual([TEST_PUBLIC, 720]);
  });

  it("executes 'skn admin sweep-fees' and rejects sweeping more than accrued", async () => {
    const server = new FakeRpc({
      results: {
        admin: TEST_PUBLIC,
        fees_accrued: 1_000_000n,
        sweep_fees: null,
      },
    });

    const result = await run(
      [
        "admin",
        "sweep-fees",
        "--contract-id",
        CONTRACT_ID,
        "--treasury",
        TREASURY_ID,
        "--amount",
        "400_000",
        "--yes",
        "--json",
      ],
      adminOptions(server),
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toMatchObject({
      submitted: true,
      command: "sweep-fees",
      current: "1000000",
      next: "600000",
      treasury: TREASURY_ID,
      amount: "400000",
    });
    expect(server.calls.at(-1)?.args).toEqual([TEST_PUBLIC, TREASURY_ID, 400_000n]);

    // Sweeping more than accrued fails before submitting.
    const overServer = new FakeRpc({
      results: {
        admin: TEST_PUBLIC,
        fees_accrued: 100n,
      },
    });
    const overRes = await run(
      [
        "admin",
        "sweep-fees",
        "--contract-id",
        CONTRACT_ID,
        "--treasury",
        TREASURY_ID,
        "--amount",
        "500",
        "--yes",
      ],
      adminOptions(overServer),
    );
    expect(overRes.exitCode).toBe(EXIT.contract);
    expect(overRes.stderr).toContain("NoRewardsAvailable");
    expect(overServer.submitted).toHaveLength(0);
  });
});
