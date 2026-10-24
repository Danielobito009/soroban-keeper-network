//! Example demonstrating how a condition contract would use the oracle-client.
//!
//! This example is not compiled as part of the test suite but serves as documentation
//! for consumers of the oracle-client crate.

use oracle_client::{Asset, PriceData, ReflectorPulseClient};
use soroban_sdk::{Address, Env, Symbol};

/// Example: A condition contract reads a BTC price from Reflector.
pub fn read_btc_price(env: Env, oracle_address: Address) -> Option<i128> {
    // Create a typed client
    let client = ReflectorPulseClient::new(&env, &oracle_address);

    // Request the most recent BTC price
    let btc = Asset::Other(Symbol::new(&env, "BTC"));
    let price_data = client.lastprice(&btc)?;

    // Get decimals for scaling
    let decimals = client.decimals();

    // Scale the price
    let scaled_price = price_data.price / 10i128.pow(decimals);

    Some(scaled_price)
}

/// Example: A condition contract enforces a staleness rule.
pub fn read_fresh_btc_price(
    env: Env,
    oracle_address: Address,
    max_age_seconds: u64,
) -> Option<i128> {
    let client = ReflectorPulseClient::new(&env, &oracle_address);

    let btc = Asset::Other(Symbol::new(&env, "BTC"));
    let price_data = client.lastprice(&btc)?;

    // Check staleness
    let current_timestamp = env.ledger().timestamp();
    if current_timestamp - price_data.timestamp > max_age_seconds {
        // Price is too old
        return None;
    }

    let decimals = client.decimals();
    Some(price_data.price / 10i128.pow(decimals))
}

/// Example: A condition contract handles missing prices gracefully.
pub fn safe_read_price(env: Env, oracle_address: Address, symbol: &str) -> Result<i128, &'static str> {
    let client = ReflectorPulseClient::new(&env, &oracle_address);

    let asset = Asset::Other(Symbol::new(&env, symbol));
    let price_data = match client.lastprice(&asset) {
        Some(data) => data,
        None => {
            // Asset is not available on this oracle
            return Err("price_not_available");
        }
    };

    let decimals = client.decimals();
    Ok(price_data.price / 10i128.pow(decimals))
}
