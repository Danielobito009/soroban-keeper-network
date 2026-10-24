/**
 * Re-exports the SDK's `FakeRpc` so CLI tests exercise the real
 * `@stellar/stellar-sdk` XDR encoding round-trip without touching the network.
 */
export { FakeRpc, type FakeRpcOptions, type RecordedCall } from "../../../sdk-ts/test/support/fakeRpc.js";
