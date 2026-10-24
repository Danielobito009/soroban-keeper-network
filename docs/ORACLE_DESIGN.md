# Oracle-Backed Task Conditions

**Status:** Reflector-first architecture approved. Band support is deferred
pending maintained, network-specific deployments.

## Scope

Oracle conditions implement the generic E10 `ITaskCondition::is_met(task_id)`
interface. The registry stores only the condition contract address and has no
oracle-specific storage or entry points. Provider calls, normalization,
freshness checks, and predicate evaluation stay inside the condition contract.

Each condition deployment has immutable configuration: provider address,
asset, predicate parameters, and maximum data age. Changing any of those
assumptions requires deploying a new condition and registering a new task.

## Supported providers

| Provider | Decision | Reason |
|---|---|---|
| Reflector Pulse | Supported first | Soroban-native SEP-40 interface with `lastprice`, `decimals`, and observation timestamps. |
| Reflector Beam | Deferred | Its invocation fee needs a separate authorization and fee-budget design before a claimability view can remain side-effect-free. |
| Band Standard Reference | Deferred; see feasibility study below | A Soroban implementation exists, but no maintained source currently publishes verifiable Testnet and Mainnet contract IDs. |
| Arbitrary look-alike feeds | Unsupported by reference deployments | Matching an ABI does not establish data quality or operator trust. |

Reference deployments must pin an oracle contract ID and network together.
The same contract ID must never be assumed to identify a supported provider on
another network.

## Canonical price and freshness rules

Condition logic consumes one internal shape:
# Oracle-Backed Task Conditions Design (E11)

**Status:** design approved for implementation. This document fixes the
provider, freshness, arithmetic, and contract-boundary decisions that all E11
implementations must follow.

## 1. Scope and goals

E11 adds reusable task-condition contracts that decide whether an on-chain
price predicate is currently true. It does not make the keeper registry an
oracle, select a price on behalf of a task owner, or guarantee the economic
quality of a feed. The owner chooses a condition contract and accepts the feed,
asset, threshold, and freshness policy embedded in that contract.

The initial predicates are:

- price at or above/below an immutable threshold; and
- absolute price movement by an immutable number of basis points from an
  immutable reference price.

All examples and deployment manifests must identify the network, oracle
contract address, quoted asset, base asset, and maximum age. A contract ID from
one network must never be reused as evidence that the same provider is trusted
on another network.

## 2. Supported oracle list

| Provider | E11 status | Decision |
| --- | --- | --- |
| Reflector Pulse | Primary, implement first | Supported. Pulse is Soroban-native, exposes the SEP-40 `lastprice`, `decimals`, and timestamp data required by the conditions, and does not charge an invocation token fee. Its uniform five-minute publication interval also makes freshness configuration predictable. |
| Band Standard Reference for Soroban | Supported through a separate adapter | Supported once a current contract ID is pinned per network in `docs/DEPLOYMENTS.md`. Band documents Soroban mainnet and testnet deployments and returns a fixed 18-decimal rate plus update timestamps. Its ABI is not SEP-40, so a Band adapter must not masquerade as the Reflector client. |
| Reflector Beam | Deferred | Beam is SEP-40-compatible but charges an XRF invocation fee and requires the calling contract to authorize that spend. Claim preflight must remain a read-only predicate without hidden token expenditure, so Beam is out of scope until a separate design assigns and caps that cost. |
| Arbitrary SEP-40-compatible contracts | Not trusted by reference deployments | Interface compatibility does not establish feed quality. Third parties may deploy conditions against another SEP-40 contract, but official Keeper Network deployment manifests only label reviewed, pinned oracle addresses as supported. |
| Off-chain HTTP APIs or keeper-supplied prices | Excluded | They are not on-chain sources and would let the caller choose or alter the value being checked. |

The Reflector decisions are based on its public contract documentation, which
defines both Pulse and Beam as SEP-40-compatible, represents prices as `i128`
with a contract-wide decimal count, and requires consumers to check the returned
timestamp for staleness:
<https://github.com/reflector-network/reflector-contract>.

The Band decision is based on Band's Soroban Standard Reference implementation
and deployment announcement. `get_reference_data` returns a `u128` rate scaled
by `1e18`, together with base and quote update timestamps:
<https://github.com/bandprotocol/band-std-reference-contracts-soroban> and
<https://blog.bandprotocol.com/bandprotocol-integration-with-stellar-smart-contracts/>.

## 3. Contract architecture

Oracle support is implemented as **separate provider-specific condition
contracts**, not as a mutable provider setting in one universal contract.
Reflector and Band have different call signatures, asset identifiers, timestamp
semantics, authorization behavior, and failure surfaces. Keeping their adapters
separate makes the deployed WASM and audit boundary explicit and prevents a
configuration change from silently switching the source for an existing task.

Each deployed condition instance has immutable configuration:

```text
provider contract address
network identifier
base and quoted asset identifiers
predicate kind and direction
threshold or reference price, scaled to 18 decimals
maximum age in seconds
```

No administrator may change those fields after initialization. A task owner who
wants a different feed or threshold registers a new condition instance and a
new task. Reference deployment manifests pin the provider address and its
network; a successfully shaped response from an unlisted contract is not enough
to call it a supported oracle.

Provider adapters expose one internal result shape to predicate logic:

```rust
struct NormalizedPrice {
    value: u128,       // positive price at exactly 18 decimal places
    observed_at: u64,  // Unix timestamp
}
```

All prices normalize to `PRICE_SCALE = 10^18`; floating-point values and
rounding are forbidden. For a positive Reflector value `p` with `d` decimals:

```text
require 0 <= d <= 18
normalized = p * 10^(18 - d)
```

The conversion, exponentiation, and multiplication use checked operations.
Zero, negative, over-precision, or overflowing values fail closed. Band rates
are already documented as 18-decimal `u128` values and require no rescaling.

For ledger time `now`, data is fresh exactly when:

```text
observed_at <= now
and
now - observed_at <= max_age_seconds
```

The boundary is inclusive. Missing, stale, future-dated, malformed, zero, or
unreadable data returns `false`; it never reuses a cached observation. The
configured maximum age is immutable and must be in `1..=86_400` seconds.

## Predicate arithmetic

Threshold conditions compare normalized values directly. Deviation conditions
evaluate an absolute move from the immutable reference price without division:

```text
absolute_difference * 10_000 >= reference_price * basis_points
```

Both products use checked 256-bit arithmetic. The reference must be positive
and `basis_points` must be in `0..=10_000`. Capturing the reference once during
condition initialization prevents any later caller from moving the trigger.

## Band Protocol feasibility study

Reviewed on 2026-10-17 against Band's official
[Soroban Standard Reference repository](https://github.com/bandprotocol/band-std-reference-contracts-soroban)
and [Soroban integration announcement](https://blog.bandprotocol.com/bandprotocol-integration-with-stellar-smart-contracts/).

### Deployment finding

Band announced that its oracle service was available on Soroban Mainnet and
Testnet in 2024. The maintained source repository, however, currently provides
only local/Futurenet deployment instructions. It does not publish a current
contract ID, deployment ledger, or code checksum for either Stellar Testnet or
Mainnet, and it has no tagged release that a deployment can be tied to.

Accordingly, Keeper Network has **no verifiable Band contract ID to list for
Testnet and no verifiable Band contract ID to list for Mainnet**. This does not
claim that no historical deployment ever existed; it means no current official
deployment can be pinned and reviewed to the standard required by reference
condition contracts.

### Interface finding

The published ABI is technically adaptable but is not SEP-40:

```text
get_reference_data(Vec<(Symbol, Symbol)>)
    -> Result<Vec<ReferenceData>, Error>

ReferenceData {
    rate: u128,               // 18 decimal places
    last_updated_base: u64,
    last_updated_quote: u64,
}
```

A future adapter would call one base/quote pair, require exactly one result,
require a positive rate, and map it to the shared shape as follows:

```text
value = rate
observed_at = min(last_updated_base, last_updated_quote)
```

Using the older of the two timestamps prevents one freshly updated side from
masking stale data on the other. Provider errors, malformed vector lengths, and
conversion failures all map to a closed `false` condition result.

### Decision and revisit gate

Band support is deferred. It can be revisited only when all of the following
are available from an official Band source:

1. Current Testnet and Mainnet contract IDs, identified separately.
2. Deployment ledgers and WASM/code hashes that make those IDs reproducible.
3. A tagged or otherwise immutable ABI revision with an active maintenance
   statement for Soroban.
4. Test vectors confirming the rate scale and timestamp units on both networks.

When those requirements are met, add a provider-specific Band client rather
than making it impersonate Reflector's SEP-40 client. The adapter must return
the same internal `NormalizedPrice`, pass the shared missing/stale/future-data
tests, and pin the reviewed provider address in deployment documentation.

## Trust boundary

A fresh value may still be economically wrong or manipulable. Freshness only
bounds age. Permissionless task registration also permits owners to attach
custom condition contracts; that does not make their feeds endorsed. Official
deployments label only reviewed and pinned provider addresses as supported.

Feed failure can leave a task pending until the feed recovers or the existing
cancellation/expiry path is used. This denial-of-service tradeoff is accepted
instead of allowing claims when required market data is unknown.
    observed_at: u64,  // Unix timestamp used by the freshness rule
}
```

This shape is internal to E11. It is not a new registry ABI and is not returned
to keepers.

## 4. Relationship to the E10 condition interface

An oracle condition is an implementation of the generic task-condition
interface defined by E10 issue 0390; it is not a special registry feature. The
registry stores only the condition contract address and invokes the same boolean
predicate used for every other condition. The oracle condition reads its pinned
feed and returns:

- `true` only when the configured price predicate is met with valid, fresh data;
- `false` for a valid, fresh price that does not meet the predicate; and
- `false` for every oracle or normalization failure described below.

Consequently, the registry needs no oracle-specific entry point, storage field,
event, or error. A `false` result follows E10 semantics: the claim is refused and
the task remains pending. A task without a condition remains on E10's unchanged
fast path and performs no oracle call.

The exact E10 method signature remains owned by `docs/TASK_CONDITIONS_DESIGN.md`.
E11 contracts must implement that signature verbatim when E10 lands; they must
not publish a competing `check_price` registry callback. Provider querying and
normalization happen entirely behind the E10 predicate call.

## 5. Freshness and missing-data rule

Oracle data **fails closed**. A claim is refused when the price is absent,
stale, future-dated, malformed, non-positive, cannot be normalized, or the
oracle call returns an error or panics. A failed read never reuses a previously
observed value.

For ledger time `now`, a price is fresh exactly when:

```text
observed_at <= now
and
now - observed_at <= max_age_seconds
```

The upper boundary is inclusive. A record exactly `max_age_seconds` old is
fresh; it becomes stale one second later. `max_age_seconds` is immutable, must
be in `1..=86_400`, and is expressed in seconds. Reflector uses the returned
`PriceData.timestamp`. Band uses
`min(last_updated_base, last_updated_quote)` so neither side of a pair may be
stale while the other masks it.

The recommended Reflector Pulse value is 600 seconds, twice its documented
five-minute publication interval. Deployments may choose a smaller or larger
value inside the bound based on their risk tolerance, but must publish it.

The provider call must use Soroban's non-propagating invocation path. Any host
error, conversion error, explicit provider error, or callee panic maps to the
same closed result. This protects the registry transaction from treating an
unreadable feed as permission to claim; it does not make a broken feed
available.

## 6. Decimal normalization

Every E11 price and configured threshold uses the canonical scale
`PRICE_SCALE = 10^18`. No floating-point values, strings, division-based
rescaling, or rounding are permitted in a condition contract.

### Reflector

Given a positive `i128` Reflector price `p` and `decimals()` value `d`:

```text
require 0 <= d <= 18
normalized = u128(p) * 10^(18 - d)
```

The sign conversion, exponentiation, and multiplication are checked. A negative
or zero price, `d > 18`, or arithmetic overflow fails closed. Rejecting precision
above 18 avoids an implicit rounding policy; a later design and interface-version
change is required before such a feed can be supported.

### Band

Band's `ReferenceData.rate` is already a `u128` scaled by `1e18`, so:

```text
require rate > 0
normalized = rate
```

No rescaling is performed. Both provider paths therefore produce the same
`u128` unit before predicate evaluation.

### Predicate arithmetic

Threshold comparison uses normalized `u128` values directly. Deviation uses
wide checked integer arithmetic before division:

```text
absolute_difference * 10_000 >= reference_price * basis_points
```

The implementation must use `U256` (or an equivalently wide checked type) for
both products. `reference_price` must be positive and `basis_points` must be in
`0..=10_000`. Integer division is deliberately absent from the comparison, so
there is no rounding direction to interpret differently across contracts.

## 7. Failure and trust boundaries

The following are deliberate properties, not guarantees supplied by the
registry:

- A fresh value may still be economically wrong or manipulable. Freshness only
  bounds age.
- A task owner can attach a custom condition or a condition backed by an
  untrusted feed. Permissionless registration does not endorse that source.
- A stale or unavailable feed can strand a task in Pending until the feed
  recovers or the task reaches an existing cancellation or expiry path. This is
  accepted in preference to allowing a claim on unknown data.
- Oracle-conditioned claims add the resource cost of registry -> condition ->
  oracle calls to the keeper's transaction. Keepers should simulate before
  submission; E11 does not add an in-contract subcall budget.
- Official condition deployments pin provider addresses. Accepting an arbitrary
  address merely because it implements the expected ABI would permit a
  look-alike contract to manufacture prices.

The E11 security review must revisit manipulation cost, provider-address
pinning, staleness denial of service, reentry, and resource measurements using
the deployed implementations. This document chooses interfaces and policies; it
does not claim that either provider or a future condition implementation has
been audited by Keeper Network.

## 8. Required conformance tests

Every provider adapter and every oracle condition must share table-driven tests
covering:

- missing, zero, negative (where representable), stale, exact-boundary, and
  future-dated prices;
- oracle error, panic, malformed return value, unsupported decimals, and
  normalization overflow;
- equivalent values from feeds using 0, 7, 14, and 18 decimals;
- above and below threshold equality boundaries;
- deviation values at 0, 1, and 10,000 basis points;
- an oracle address on the wrong network or outside the deployment allowlist;
  and
- confirmation that rejection leaves the registry task pending and emits only
  the E10 condition-rejection event.

The mock feed must implement the same provider ABI as the adapter it exercises.
Tests may not substitute a different convenience interface and call that
provider compatibility.

## 9. Deferred decisions

- Reflector Beam support is deferred until fee sponsorship, allowance lifetime,
  and read-only preflight semantics have a separate reviewed design.
- Cross-provider aggregation, medianization, and automatic fallback are
  deferred. Silently falling back would change a task's trust assumptions.
- Feeds with more than 18 decimals are deferred rather than rounded.
- Mutable thresholds, mutable feed addresses, and registry-level oracle
  allowlists are deferred. Reference deployments remain pinned and immutable;
  the registry itself remains permissionless.
- Keeper-side direct feed prechecks are an optimization only. The on-chain
  condition remains authoritative for claim acceptance.
