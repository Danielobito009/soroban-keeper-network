//! Price-Threshold Condition Contract
//!
//! A reference implementation of the condition interface (issue 0390) that returns true
//! once a configured oracle-reported price crosses a configured threshold.
//!
//! # Design
//!
//! This condition reads the current price from a configured oracle contract at call time
//! (not trusting any cached or caller-supplied value) and compares it against a threshold.
//! The condition returns `true` if the price crosses the threshold, enabling the task to be claimed.
//!
//! # Oracle Interface
//!
//! The oracle contract must implement two methods:
//! - `lastprice() -> (i128, u32)` — Returns (price, decimals)
//! - `decimals() -> u32` — Returns the decimal places for price normalization
//!
//! # Storage
//!
//! The contract stores:
//! - `oracle`: The address of the oracle contract to query
//! - `threshold`: The price threshold (in base units, before decimal adjustment)
//! - `direction`: Whether the condition triggers on price crossing above or below the threshold

use soroban_sdk::{contractimpl, contractclient, log, panic_with_error, Address, Env, Symbol};

/// Direction for threshold crossing: true = above, false = below
pub type ThresholdDirection = bool;
const THRESHOLD_ABOVE: ThresholdDirection = true;
const THRESHOLD_BELOW: ThresholdDirection = false;

/// Storage keys
const KEY_ORACLE: &str = "oracle";
const KEY_THRESHOLD: &str = "threshold";
const KEY_DIRECTION: &str = "direction";

/// Error codes for this condition contract
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ConditionError {
    /// Contract has not been initialized
    NotInitialized = 1,
    /// Oracle call failed or returned invalid data
    OracleCallFailed = 2,
    /// Price data is stale (optional, for future use)
    StalePriceData = 3,
}

impl ConditionError {
    pub fn into_symbol(self) -> Symbol {
        match self {
            ConditionError::NotInitialized => Symbol::new(&Env::default(), "NotInit"),
            ConditionError::OracleCallFailed => Symbol::new(&Env::default(), "OracleErr"),
            ConditionError::StalePriceData => Symbol::new(&Env::default(), "StalePrice"),
        }
    }
}

/// The oracle interface: contract must implement `lastprice()` and `decimals()`
#[contractclient(name = "OracleClient")]
pub trait IOraclePrice {
    /// Returns (price, decimals) — price in smallest units, decimals is the scaling factor
    fn lastprice(env: Env) -> (i128, u32);
}

/// The condition interface: implemented by any contract used as a task condition.
/// External condition contracts implement this trait.
#[contractclient(name = "ConditionClient")]
pub trait ICondition {
    /// Initialize the condition with configuration.
    ///
    /// # Arguments
    /// - `oracle`: Address of the oracle contract
    /// - `threshold`: The threshold value (in smallest oracle units)
    /// - `direction`: true = trigger when price goes above threshold, false = below
    fn initialize(env: Env, oracle: Address, threshold: i128, direction: ThresholdDirection);

    /// Check if the condition is satisfied.
    ///
    /// Returns true if the current oracle price crosses the configured threshold
    /// in the configured direction.
    fn check(env: Env) -> bool;
}

pub struct PriceThresholdCondition;

#[contractimpl]
impl PriceThresholdCondition {
    /// Initialize the condition with an oracle and threshold.
    ///
    /// # Arguments
    /// - `oracle`: Address of the oracle contract to query for prices
    /// - `threshold`: The price threshold value (in the oracle's base units)
    /// - `direction`: true to trigger when price > threshold, false for price < threshold
    pub fn initialize(env: Env, oracle: Address, threshold: i128, direction: ThresholdDirection) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, KEY_ORACLE), &oracle);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, KEY_THRESHOLD), &threshold);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, KEY_DIRECTION), &direction);

        // Extend the instance storage TTL
        env.storage().instance().extend_ttl(1000, 100000);
    }

    /// Check if the condition is currently satisfied.
    ///
    /// Reads the current price from the oracle and compares it against the stored threshold.
    /// Returns true if the price crosses the threshold in the configured direction.
    ///
    /// # Returns
    /// - `true` if the condition is satisfied (price crosses threshold)
    /// - `false` if the condition is not satisfied
    ///
    /// # Panics
    /// If the contract is not initialized or if the oracle call fails
    pub fn check(env: Env) -> bool {
        // Retrieve stored configuration
        let oracle: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, KEY_ORACLE))
            .ok_or_else(|| {
                log!(&env, "check: not initialized");
                panic_with_error!(&env, ConditionError::NotInitialized)
            })
            .unwrap();

        let threshold: i128 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, KEY_THRESHOLD))
            .ok_or_else(|| {
                log!(&env, "check: threshold not set");
                panic_with_error!(&env, ConditionError::NotInitialized)
            })
            .unwrap();

        let direction: ThresholdDirection = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, KEY_DIRECTION))
            .ok_or_else(|| {
                log!(&env, "check: direction not set");
                panic_with_error!(&env, ConditionError::NotInitialized)
            })
            .unwrap();

        // Call the oracle to get the current price
        let oracle_client = OracleClient::new(&env, &oracle);
        let (price, _decimals) = oracle_client.lastprice();

        log!(
            &env,
            "check: price={}, threshold={}, direction={}",
            price,
            threshold,
            if direction { "above" } else { "below" }
        );

        // Compare price against threshold based on direction
        if direction == THRESHOLD_ABOVE {
            price > threshold
        } else {
            price < threshold
        }
    }
}

#[cfg(test)]
mod test;
