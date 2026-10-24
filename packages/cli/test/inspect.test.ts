import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { EXIT } from "../src/exitCodes.js";
import { CONTRACT_ID } from "./support/env.js";
import { FakeRpc } from "./support/fakeRpc.js";

describe("skn inspect protocol summary (#706)", () => {
  it("prints protocol state from read-only views without sending any transaction", async () => {
    const server = new FakeRpc({
      results: {
        version: 3,
        is_paused: false,
        get_fee_bps: 300,
        min_reward: 1_000_000n,
        min_stake: 50_000_000n,
        fees_accrued: 250_000n,
        task_count: 42,
      },
    });

    const result = await run(["inspect", "--contract-id", CONTRACT_ID], { server });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`contract ${CONTRACT_ID} on testnet`);
    expect(result.stdout).toContain("version:           3 (compatible (supported: 1..3))");
    expect(result.stdout).toContain("paused:            false");
    expect(result.stdout).toContain("fee bps:           300 (3.00%)");
    expect(result.stdout).toContain("min reward:        1000000 stroops");
    expect(result.stdout).toContain("min stake:         50000000 stroops");
    expect(result.stdout).toContain("fees accrued:      250000 stroops");
    expect(result.stdout).toContain("task count:        42");
    expect(result.stdout).toContain("sdk compatibility: compatible");
    // Every value comes from a read-only view; no transaction is submitted.
    expect(server.submitted).toHaveLength(0);
    expect(server.calls.map((c) => c.method)).toEqual([
      "version",
      "is_paused",
      "get_fee_bps",
      "min_reward",
      "min_stake",
      "fees_accrued",
      "task_count",
    ]);
  });

  it("supports 'skn inspect summary' and --json with bigint fields as decimal strings", async () => {
    const server = new FakeRpc({
      results: {
        version: 2,
        is_paused: true,
        get_fee_bps: 250,
        min_reward: 5_000_000n,
        min_stake: 100_000_000n,
        fees_accrued: 900_000n,
        task_count: 7,
      },
    });

    const result = await run(
      ["inspect", "summary", "--contract-id", CONTRACT_ID, "--json"],
      { server },
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stderr).toBe("");
    expect(server.submitted).toHaveLength(0);
    expect(JSON.parse(result.stdout)).toEqual({
      contractId: CONTRACT_ID,
      network: "testnet",
      version: 2,
      contractVersion: 2,
      paused: true,
      feeBps: 250,
      minReward: "5000000",
      minStake: "100000000",
      feesAccrued: "900000",
      taskCount: 7,
      compatible: true,
      status: "compatible",
      supportedVersions: { min: 1, max: 3 },
      compatibility: {
        status: "compatible",
        supported: { min: 1, max: 3 },
      },
    });
  });

  it("prints a warning when the deployed contract version is newer than SUPPORTED_CONTRACT_VERSIONS", async () => {
    const server = new FakeRpc({
      results: {
        version: 99,
        is_paused: false,
        get_fee_bps: 300,
        min_reward: 0n,
        min_stake: 0n,
        fees_accrued: 0n,
        task_count: 0,
      },
    });

    const result = await run(["inspect", "--contract-id", CONTRACT_ID], { server });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("version:           99 (contract-newer (supported: 1..3))");
    expect(result.stdout).toContain("sdk compatibility: contract-newer");
    expect(result.stderr).toContain(
      "skn: warning: The deployed keeper-registry reports VERSION 99",
    );
    expect(server.submitted).toHaveLength(0);
  });

  it("prints a warning when the deployed contract version is older than SUPPORTED_CONTRACT_VERSIONS", async () => {
    const server = new FakeRpc({
      results: {
        version: 0,
        is_paused: false,
        get_fee_bps: 300,
        min_reward: 0n,
        min_stake: 0n,
        fees_accrued: 0n,
        task_count: 0,
      },
    });

    const result = await run(
      ["inspect", "--contract-id", CONTRACT_ID, "--json"],
      { server },
    );

    expect(result.exitCode).toBe(EXIT.ok);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.compatible).toBe(false);
    expect(parsed.status).toBe("contract-older");
    expect(parsed.compatibility.warning).toContain("VERSION 0");
    expect(result.stderr).toContain(
      "skn: warning: The deployed keeper-registry reports VERSION 0",
    );
    expect(server.submitted).toHaveLength(0);
  });

  it("supports 'skn inspect version' for checking just the contract version", async () => {
    const server = new FakeRpc({ results: { version: 3 } });

    const result = await run(
      ["inspect", "version", "--contract-id", CONTRACT_ID],
      { server },
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("VERSION 3 (supported by this CLI)");
    expect(server.submitted).toHaveLength(0);
  });

  it("maps a contract simulation error to EXIT.contract", async () => {
    const server = new FakeRpc({
      simulationErrors: { is_paused: "Error(Contract, #15)" },
      results: { version: 3 },
    });

    const result = await run(
      ["inspect", "--contract-id", CONTRACT_ID, "--json"],
      { server },
    );

    expect(result.exitCode).toBe(EXIT.contract);
    expect(JSON.parse(result.stdout).error.code).toBe("CONTRACT_ERROR");
  });
});
