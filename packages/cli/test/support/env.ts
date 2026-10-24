import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

/** A throwaway directory for one test. Call `cleanup` in `afterEach`. */
export async function scratchDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "skn-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A structurally valid secret seed for tests. */
export const TEST_KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
export const TEST_SECRET = TEST_KEYPAIR.secret();
export const TEST_PUBLIC = TEST_KEYPAIR.publicKey();

/** A second distinct keypair for non-admin / other-signer tests. */
export const OTHER_KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 21));
export const OTHER_SECRET = OTHER_KEYPAIR.secret();
export const OTHER_PUBLIC = OTHER_KEYPAIR.publicKey();

export const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
export const TREASURY_ID = StrKey.encodeContract(Buffer.alloc(32, 8));
export const TOKEN_ID = StrKey.encodeContract(Buffer.alloc(32, 11));
