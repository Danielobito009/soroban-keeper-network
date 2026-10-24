# oracle-client: Typed Client for Reflector Price Feeds

A minimal Soroban contract library providing type-safe access to the Reflector price-feed oracle.

## Overview

Condition contracts in the Soroban Keeper Network need to read oracle prices to evaluate task conditions. This crate provides a single, shared typed client for the [Reflector oracle](https://github.com/reflector-network/reflector-contract), eliminating the need for each condition contract to re-declare the interface.

### Scope

- ✅ Typed client for Reflector's `lastprice()` and `decimals()` methods
- ✅ `Asset` enum for Stellar and external assets
- ✅ `PriceData` struct with price and timestamp
- ✅ `no_std` compatible, usable from any condition contract
- ❌ No staleness policy (caller decides)
- ❌ No condition evaluation logic
- ❌ No changes to existing contracts

## Quick Start

### Add to Your Contract

```toml
[dependencies]
oracle-client = { path = "../../oracle-client" }
```

### Read a Price

```rust
use oracle_client::{ReflectorPulseClient, Asset};
use soroban_sdk::{Address, Symbol};

pub fn fetch_btc_price(env: Env, oracle_addr: Address) -> Option<i128> {
    let client = ReflectorPulseClient::new(&env, &oracle_addr);
    
    let asset = Asset::Other(Symbol::new(&env, "BTC"));
    let price_data = client.lastprice(&asset)?;
    
    // Scale the price
    let decimals = client.decimals();
    Some(price_data.price / 10i128.pow(decimals))
}
```

## API

### ReflectorPulseClient

Typed client for Reflector Pulse oracles (free, 5-minute updates).

- `decimals() -> u32` — Decimal precision for all prices
- `lastprice(asset: Asset) -> Option<PriceData>` — Most recent price for an asset
- `base() -> Asset` — Base currency of the oracle
- `assets() -> Vec<Asset>` — All quoted assets
- And other read-only methods (see Rustdoc)

### Asset

```rust
pub enum Asset {
    Stellar(Address),  // Soroban or Classic asset
    Other(Symbol),     // External asset (e.g., "BTC", "EUR")
}
```

### PriceData

```rust
pub struct PriceData {
    pub price: i128,      // Scaled by 10^decimals
    pub timestamp: u64,   // Unix seconds; check for staleness
}
```

## Staleness

Prices include a timestamp. **The caller is responsible** for checking staleness:

```rust
let now = env.ledger().timestamp();
if now - price_data.timestamp > MAX_AGE_SECONDS {
    // Price is too old
}
```

This crate enforces no staleness policy, allowing each condition contract to apply its own rules.

## Missing Prices

If an asset is not available on the oracle, `lastprice()` returns `None` (not a panic):

```rust
match client.lastprice(&asset) {
    Some(data) => { /* use price */ }
    None => { /* asset not found */ }
}
```

## Source of Truth

This crate implements the Reflector Pulse interface exactly as deployed:

**Repository:** https://github.com/reflector-network/reflector-contract

**Mainnet Oracle Address:** `CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN`

## Design

### Minimal Surface

This crate exports only:
- `ReflectorPulseClient` — the typed contract interface
- `Asset` — asset identifier enum
- `PriceData` — price record struct

No policy, no staleness rules, no condition evaluation. Callers integrate these types into their own logic.

### no_std Compatible

The crate is `#![no_std]` and uses only `soroban-sdk`, making it suitable for resource-constrained contract execution.

### Type Safety

The `#[contractclient]` macro ensures compile-time type safety. If the deployed Reflector interface changes, Rust will fail at build time rather than runtime.

## Testing

The crate includes integration tests with a mock Reflector contract:

```bash
cargo test -p oracle-client
```

Tests verify:
- Price and timestamp round-trip correctly
- Missing prices return `None` instead of panicking
- Decimals are exposed for scaling
- Type safety of Asset and PriceData

## Example: Integration in a Condition Contract

```rust
use oracle_client::{ReflectorPulseClient, Asset};

#[contract]
pub struct MyConditionContract;

#[contractimpl]
impl MyConditionContract {
    pub fn evaluate_condition(
        env: Env,
        oracle_addr: Address,
        max_price_age: u64,
    ) -> bool {
        let client = ReflectorPulseClient::new(&env, &oracle_addr);
        let btc = Asset::Other(Symbol::new(&env, "BTC"));
        
        match client.lastprice(&btc) {
            Some(price_data) => {
                // Enforce staleness rule
                let now = env.ledger().timestamp();
                if now - price_data.timestamp > max_price_age {
                    return false;
                }
                
                // Apply condition logic
                let decimals = client.decimals();
                let price = price_data.price / 10i128.pow(decimals);
                price > 40_000  // e.g., BTC above $40k
            }
            None => false,  // No price available
        }
    }
}
```

## Files

- `src/lib.rs` — Type declarations and client interface
- `Cargo.toml` — Package metadata and dependencies

## Related Issues

- **#656** — This issue (oracle client implementation)
- **#416** — Oracle-backed task conditions architecture (dependency)
- **Reflector repository:** https://github.com/reflector-network/reflector-contract
