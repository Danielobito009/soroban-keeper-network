import {
  KeeperRegistryClient,
  treasury,
  type RpcServerLike,
  type TransactionSigner,
} from "@soroban-keeper-network/sdk";
import type { CommandContext } from "./args.js";
import { SettingsError, type Settings } from "./settings.js";

/**
 * Builds the registry client for one command. Read-only commands pass no
 * signer. A command that submits a transaction passes one, built from the key
 * source. `server` is set only when the command needs to share one RPC server
 * with a preview, or when a test injects the SDK's fake.
 */
export function openRegistry(
  settings: Settings,
  context: CommandContext,
  warnings: string[],
  options: { signer?: TransactionSigner; server?: RpcServerLike; contractId?: string } = {},
): KeeperRegistryClient {
  const contractId = options.contractId ?? settings.contractId;
  if (contractId === undefined) {
    throw new SettingsError("--contract-id is required (or set contractId in the selected profile)");
  }
  const server = options.server ?? context.server;
  try {
    return new KeeperRegistryClient({
      contractId,
      networkPassphrase: settings.networkPassphrase,
      ...(server ? { server } : { rpcUrl: settings.rpcUrl }),
      ...(options.signer ? { signer: options.signer } : {}),
      warn: (message) => warnings.push(message),
    });
  } catch (err) {
    throw new SettingsError(`invalid contract ID: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Builds the treasury client for one command.
 */
export function openTreasury(
  settings: Settings,
  context: CommandContext,
  warnings: string[],
  options: { signer?: TransactionSigner; server?: RpcServerLike; contractId?: string } = {},
): treasury.TreasuryClient {
  const contractId = options.contractId ?? settings.treasuryContractId ?? settings.contractId;
  if (contractId === undefined) {
    throw new SettingsError(
      "--treasury-contract-id is required (or set treasuryContractId in the selected profile)",
    );
  }
  const server = options.server ?? context.server;
  try {
    return new treasury.TreasuryClient({
      contractId,
      networkPassphrase: settings.networkPassphrase,
      ...(server ? { server } : { rpcUrl: settings.rpcUrl }),
      ...(options.signer ? { signer: options.signer } : {}),
      warn: (message) => warnings.push(message),
    });
  } catch (err) {
    throw new SettingsError(`invalid treasury contract ID: ${err instanceof Error ? err.message : String(err)}`);
  }
}
