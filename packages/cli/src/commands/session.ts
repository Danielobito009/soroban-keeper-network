import { Keypair } from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import {
  keypairSigner,
  type KeeperRegistryClient,
  type RpcServerLike,
  type TransactionSigner,
} from "@soroban-keeper-network/sdk";
import {
  loadConfig,
  settingFlagsFrom,
  type CommandContext,
  type ParsedValues,
} from "../args.js";
import { openRegistry } from "../client.js";
import { resolveKey } from "../keys.js";
import { jsonResult, ok, usage, type RunResult } from "../output.js";
import { requireMainnetConfirmation, resolveSettings, type Settings } from "../settings.js";

/** Everything a task or keeper command needs once its flags are resolved. */
export interface Session {
  settings: Settings;
  client: KeeperRegistryClient;
  /** The RPC server the client uses, shared so a command can read the ledger height. */
  server: RpcServerLike;
  warnings: string[];
  json: boolean;
}

export interface SignedSession extends Session {
  /** `G...` address of the signing key. */
  address: string;
  signer: TransactionSigner;
}

const NO_KEY = "no signing key: set --key-file, --identity, or SKN_SECRET_KEY";

/** Resolves settings and builds a client with no signing key. */
export async function openReadOnly(
  values: ParsedValues,
  context: CommandContext,
  signer?: TransactionSigner,
): Promise<Session> {
  const config = await loadConfig(context);
  const settings = resolveSettings(settingFlagsFrom(values), config);
  const warnings: string[] = [];
  const server = context.server ?? new rpc.Server(settings.rpcUrl);
  const client = openRegistry(settings, context, warnings, { server, ...(signer ? { signer } : {}) });
  return { settings, client, server, warnings, json: values.json === true };
}

/** The signing key's address and signer, or `undefined` when no key source is set. */
export async function resolveSigner(
  values: ParsedValues,
  context: CommandContext,
): Promise<{ address: string; signer: TransactionSigner } | undefined> {
  const key = await resolveKey(
    {
      keyFile: values["key-file"] as string | undefined,
      identity: values.identity as string | undefined,
    },
    { env: context.env, homeDir: context.homeDir, platform: context.platform },
  );
  if (key === undefined) return undefined;
  const keypair = Keypair.fromSecret(key.secret);
  return { address: keypair.publicKey(), signer: keypairSigner(keypair) };
}

/**
 * Like {@link openReadOnly}, but also loads the signing key. Returns a usage
 * result when there is none, so the caller can return it as is.
 *
 * This does not apply the mainnet guard: a command that might not send a
 * transaction (nothing to withdraw, not yet withdrawable) calls
 * {@link requireMainnetConfirmation} itself, only on the path that sends one.
 */
export async function openSigned(
  values: ParsedValues,
  context: CommandContext,
): Promise<SignedSession | RunResult> {
  const signing = await resolveSigner(values, context);
  if (signing === undefined) return usage(NO_KEY, values.json === true);
  const session = await openReadOnly(values, context, signing.signer);
  return { ...session, ...signing };
}

export function isRunResult(value: SignedSession | RunResult): value is RunResult {
  return "exitCode" in value;
}

export { requireMainnetConfirmation };

/** One command's output: text for people, a document for `--json`, warnings on stderr. */
export function finish(session: Session, text: string, document: unknown): RunResult {
  const stderr = session.warnings.map((line) => `skn: warning: ${line}\n`).join("");
  const result = session.json ? jsonResult(document) : ok(`${text}\n`);
  return { ...result, stderr };
}
