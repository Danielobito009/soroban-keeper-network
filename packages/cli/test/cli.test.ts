import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeeperErrorCode } from "@soroban-keeper-network/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { explainContractError } from "../src/errors.js";
import { EXIT } from "../src/exitCodes.js";
import { resolveKey } from "../src/keys.js";
import { CLI_VERSION } from "../src/version.js";
import { CONTRACT_ID, TEST_SECRET, scratchDir } from "./support/env.js";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await scratchDir());
});

afterEach(async () => {
  await cleanup();
});

const packageJson = JSON.parse(
  await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };

describe("skn CLI foundation, config, keys, and error table", () => {
  it("lists every command group in --help and prints version in --version", async () => {
    const help = await run(["--help"]);
    expect(help.exitCode).toBe(EXIT.ok);
    for (const group of [
      "config",
      "task",
      "keeper",
      "admin",
      "batch",
      "deploy",
      "events",
      "inspect",
    ]) {
      expect(help.stdout).toMatch(new RegExp(`^\\s+${group}\\s`, "m"));
    }

    const version = await run(["--version"]);
    expect(version.exitCode).toBe(EXIT.ok);
    expect(version.stdout).toContain(`skn ${CLI_VERSION}`);
    expect(CLI_VERSION).toBe(packageJson.version);
  });

  it("initializes and displays config profiles without leaking the signing key", async () => {
    const configFile = join(dir, "skn.config.json");
    const env = { SKN_CONFIG: configFile, SKN_SECRET_KEY: TEST_SECRET };

    const init = await run(["config", "init"], { env, homeDir: dir, platform: "linux" });
    expect(init.exitCode).toBe(EXIT.ok);

    const show = await run(
      ["config", "show", "--contract-id", CONTRACT_ID, "--json"],
      { env, homeDir: dir, platform: "linux" },
    );
    expect(show.exitCode).toBe(EXIT.ok);
    expect(show.stdout).not.toContain(TEST_SECRET);
    expect(JSON.parse(show.stdout)).toMatchObject({
      profile: "testnet",
      network: "testnet",
      contractId: CONTRACT_ID,
      key: { source: "env", origin: "SKN_SECRET_KEY" },
    });
  });

  it("enforces key-file permissions on POSIX and precedence (--key-file > --identity > env)", async () => {
    const identityDir = join(dir, ".config", "stellar", "identity");
    await mkdir(identityDir, { recursive: true });
    await writeFile(
      join(identityDir, "alice.toml"),
      `secret_key = "${TEST_SECRET}"\n`,
      "utf8",
    );

    const fromIdentity = await resolveKey(
      { identity: "alice" },
      { env: {}, homeDir: dir, platform: "linux" },
    );
    expect(fromIdentity).toEqual({
      source: "identity",
      origin: "alice",
      secret: TEST_SECRET,
    });

    const openFile = join(dir, "open.key");
    await writeFile(openFile, TEST_SECRET, "utf8");
    await chmod(openFile, 0o644);
    await expect(
      resolveKey({ keyFile: openFile }, { env: {}, homeDir: dir, platform: "linux" }),
    ).rejects.toThrow("readable by other users");
  });

  it("explains every KeeperErrorCode variant", () => {
    const codes = Object.values(KeeperErrorCode).filter(
      (v): v is KeeperErrorCode => typeof v === "number",
    );
    for (const code of codes) {
      const help = explainContractError(code);
      expect(help.name).toBe(KeeperErrorCode[code]);
      expect(help.message.length).toBeGreaterThan(5);
      expect(help.hint.length).toBeGreaterThan(5);
    }
  });
});
