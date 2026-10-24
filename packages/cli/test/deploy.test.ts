import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type RunOptions } from "../src/cli.js";
import { EXIT } from "../src/exitCodes.js";
import {
  CONTRACT_ID,
  TEST_PUBLIC,
  TEST_SECRET,
  TOKEN_ID,
  TREASURY_ID,
  scratchDir,
} from "./support/env.js";
import { FakeRpc } from "./support/fakeRpc.js";

let dir: string;
let cleanup: () => Promise<void>;
let configFile: string;
let registryWasm: string;
let treasuryWasm: string;

beforeEach(async () => {
  ({ dir, cleanup } = await scratchDir());
  configFile = join(dir, "skn.config.json");
  registryWasm = join(dir, "keeper_registry.wasm");
  treasuryWasm = join(dir, "keeper_treasury.wasm");
  await writeFile(registryWasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
  await writeFile(treasuryWasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x01]));
});

afterEach(async () => {
  await cleanup();
});

function deployOptions(
  server: FakeRpc,
  confirm?: (question: string) => Promise<boolean>,
): RunOptions {
  return {
    server,
    env: {
      SKN_CONFIG: configFile,
      SKN_SECRET_KEY: TEST_SECRET,
    },
    homeDir: dir,
    platform: "linux",
    confirm,
  };
}

describe("skn deploy for registry and treasury (#704)", () => {
  it("refuses mainnet deployment without --confirm-mainnet before touching the network", async () => {
    const server = new FakeRpc();

    const result = await run(
      ["deploy", "registry", "--wasm", registryWasm, "--network", "mainnet", "--yes"],
      deployOptions(server),
    );

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("--confirm-mainnet");
    expect(server.calls).toHaveLength(0);
    expect(server.submitted).toHaveLength(0);
  });

  it("shows every initialization parameter first and requires confirmation before deploying", async () => {
    const server = new FakeRpc();
    const prompts: string[] = [];

    const result = await run(
      [
        "deploy",
        "registry",
        "--wasm",
        registryWasm,
        "--admin",
        TEST_PUBLIC,
        "--reward-token",
        TOKEN_ID,
        "--fee-bps",
        "250",
      ],
      deployOptions(server, async (question) => {
        prompts.push(question);
        return false;
      }),
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`deployer:     ${TEST_PUBLIC}`);
    expect(prompts[0]).toContain(`admin:        ${TEST_PUBLIC}`);
    expect(prompts[0]).toContain(`reward_token: ${TOKEN_ID}`);
    expect(prompts[0]).toContain("fee_bps:      250 (2.50%)");
    expect(prompts[0]).toContain(`registry wasm: ${registryWasm}`);
    expect(result.stdout).toContain("not submitted");
    expect(server.submitted).toHaveLength(0);
  });

  it("uploads WASM, deploys, initializes registry and treasury, and saves IDs to the selected profile", async () => {
    await run(["config", "init"], {
      env: { SKN_CONFIG: configFile },
      homeDir: dir,
      platform: "linux",
    });

    const server: FakeRpc = new FakeRpc({
      results: {
        create_contract: () => (server.submitted.length <= 2 ? CONTRACT_ID : TREASURY_ID),
        initialize: null,
      },
    });

    const result = await run(
      [
        "deploy",
        "all",
        "--registry-wasm",
        registryWasm,
        "--treasury-wasm",
        treasuryWasm,
        "--reward-token",
        TOKEN_ID,
        "--fee-bps",
        "300",
        "--profile",
        "testnet",
        "--yes",
        "--json",
      ],
      deployOptions(server),
    );

    expect(result.exitCode).toBe(EXIT.ok);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.submitted).toBe(true);
    expect(parsed.profile).toBe("testnet");
    expect(parsed.contractId).toBe(CONTRACT_ID);
    expect(parsed.treasuryContractId).toBe(TREASURY_ID);
    expect(parsed.registry.contractId).toBe(CONTRACT_ID);
    expect(parsed.registry.wasmHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.treasury.contractId).toBe(TREASURY_ID);
    expect(parsed.treasury.wasmHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.parameters).toEqual({
      deployer: TEST_PUBLIC,
      admin: TEST_PUBLIC,
      rewardToken: TOKEN_ID,
      feeBps: 300,
    });

    // 3 transactions for registry (upload, deploy, initialize) + 3 for treasury = 6
    expect(server.submitted).toHaveLength(6);
    expect(server.calls.map((c) => c.method)).toEqual([
      "upload_contract_wasm",
      "create_contract",
      "initialize",
      "upload_contract_wasm",
      "create_contract",
      "initialize",
    ]);

    // Saved to the selected profile in the config file.
    const savedConfig = JSON.parse(await readFile(configFile, "utf8"));
    expect(savedConfig.profiles.testnet).toEqual({
      network: "testnet",
      contractId: CONTRACT_ID,
      treasuryContractId: TREASURY_ID,
    });
  });

  it("validates fee-bps and reward-token before uploading anything", async () => {
    const server = new FakeRpc();

    const badFee = await run(
      [
        "deploy",
        "registry",
        "--wasm",
        registryWasm,
        "--fee-bps",
        "20000",
        "--yes",
      ],
      deployOptions(server),
    );
    expect(badFee.exitCode).toBe(EXIT.contract);
    expect(badFee.stderr).toContain("InvalidFeeBps");
    expect(server.calls).toHaveLength(0);

    const badToken = await run(
      [
        "deploy",
        "registry",
        "--wasm",
        registryWasm,
        "--reward-token",
        "NOT_A_CONTRACT",
        "--yes",
      ],
      deployOptions(server),
    );
    expect(badToken.exitCode).toBe(EXIT.usage);
    expect(badToken.stderr).toContain("--reward-token");
    expect(server.calls).toHaveLength(0);
  });
});
