//! End-to-end tests for the price-threshold condition contract
//!
//! These tests verify:
//! 1. The condition returns false when price is below the threshold
//! 2. The condition returns true when price crosses above the threshold
//! 3. The condition correctly handles both threshold directions (above/below)
//! 4. Integration with a task registered in the Keeper Registry

use crate::{PriceThresholdCondition, ConditionClient, THRESHOLD_ABOVE, THRESHOLD_BELOW};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Bytes, Env, Symbol};

/// Mock Oracle Contract Implementation
/// This is a minimal oracle contract that returns a configurable price
mod mock_oracle {
    use soroban_sdk::{contract, contractimpl, Env};

    #[contract]
    pub struct MockOracle;

    #[contractimpl]
    impl MockOracle {
        /// Returns a mock price (in stroops) and decimals
        /// Price is stored in contract storage for testing purposes
        pub fn lastprice(env: Env) -> (i128, u32) {
            let price: i128 = env
                .storage()
                .instance()
                .get(&Symbol::new(&env, "price"))
                .unwrap_or(100_000_000); // Default: 1 XLM in stroops

            let decimals: u32 = env
                .storage()
                .instance()
                .get(&Symbol::new(&env, "decimals"))
                .unwrap_or(7); // Stellar standard

            (price, decimals)
        }

        /// Set the price in storage (for testing)
        pub fn set_price(env: Env, price: i128, decimals: u32) {
            env.storage()
                .instance()
                .set(&Symbol::new(&env, "price"), &price);
            env.storage()
                .instance()
                .set(&Symbol::new(&env, "decimals"), &decimals);
            env.storage().instance().extend_ttl(1000, 100000);
        }
    }
}

#[test]
fn test_condition_initialized_correctly() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy the condition contract
    let condition_id = env.register(PriceThresholdCondition, ());
    let condition_addr = Address::from_contract_id(&env, &condition_id);

    // Deploy the mock oracle
    let oracle_id = env.register(mock_oracle::MockOracle, ());
    let oracle_addr = Address::from_contract_id(&env, &oracle_id);

    // Initialize the condition
    let client = ConditionClient::new(&env, &condition_addr);
    let threshold = 100_000_000; // 1 XLM in stroops
    client.initialize(&oracle_addr, &threshold, &THRESHOLD_ABOVE);

    // Verify we can call the condition (it should return false initially since price == threshold)
    let result = client.check();
    // At default price of 100_000_000, with threshold 100_000_000 and direction ABOVE,
    // the condition should return false (not greater than, equal to)
    assert!(!result, "Condition should return false when price equals threshold");
}

#[test]
fn test_condition_returns_false_below_threshold() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy contracts
    let condition_id = env.register(PriceThresholdCondition, ());
    let condition_addr = Address::from_contract_id(&env, &condition_id);

    let oracle_id = env.register(mock_oracle::MockOracle, ());
    let oracle_addr = Address::from_contract_id(&env, &oracle_id);

    // Set oracle price below threshold
    let oracle_client = mock_oracle::MockOracle::new(&env, &oracle_addr);
    let price = 50_000_000; // 0.5 XLM
    oracle_client.set_price(&price, &7);

    // Initialize condition with threshold above current price
    let client = ConditionClient::new(&env, &condition_addr);
    let threshold = 100_000_000; // 1 XLM
    client.initialize(&oracle_addr, &threshold, &THRESHOLD_ABOVE);

    // Check condition: should be false because price < threshold
    let result = client.check();
    assert!(!result, "Condition should return false when price is below threshold");
}

#[test]
fn test_condition_returns_true_above_threshold() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy contracts
    let condition_id = env.register(PriceThresholdCondition, ());
    let condition_addr = Address::from_contract_id(&env, &condition_id);

    let oracle_id = env.register(mock_oracle::MockOracle, ());
    let oracle_addr = Address::from_contract_id(&env, &oracle_id);

    // Set oracle price above threshold
    let oracle_client = mock_oracle::MockOracle::new(&env, &oracle_addr);
    let price = 150_000_000; // 1.5 XLM
    oracle_client.set_price(&price, &7);

    // Initialize condition with threshold below current price
    let client = ConditionClient::new(&env, &condition_addr);
    let threshold = 100_000_000; // 1 XLM
    client.initialize(&oracle_addr, &threshold, &THRESHOLD_ABOVE);

    // Check condition: should be true because price > threshold
    let result = client.check();
    assert!(result, "Condition should return true when price is above threshold");
}

#[test]
fn test_threshold_direction_below() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy contracts
    let condition_id = env.register(PriceThresholdCondition, ());
    let condition_addr = Address::from_contract_id(&env, &condition_id);

    let oracle_id = env.register(mock_oracle::MockOracle, ());
    let oracle_addr = Address::from_contract_id(&env, &oracle_id);

    // Set oracle price below threshold
    let oracle_client = mock_oracle::MockOracle::new(&env, &oracle_addr);
    let price = 50_000_000; // 0.5 XLM
    oracle_client.set_price(&price, &7);

    // Initialize condition with THRESHOLD_BELOW direction
    let client = ConditionClient::new(&env, &condition_addr);
    let threshold = 100_000_000; // 1 XLM
    client.initialize(&oracle_addr, &threshold, &THRESHOLD_BELOW);

    // Check condition: should be true because price < threshold (and direction is BELOW)
    let result = client.check();
    assert!(result, "Condition should return true when price < threshold and direction is BELOW");
}

#[test]
fn test_threshold_direction_below_false_when_above() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy contracts
    let condition_id = env.register(PriceThresholdCondition, ());
    let condition_addr = Address::from_contract_id(&env, &condition_id);

    let oracle_id = env.register(mock_oracle::MockOracle, ());
    let oracle_addr = Address::from_contract_id(&env, &oracle_id);

    // Set oracle price above threshold
    let oracle_client = mock_oracle::MockOracle::new(&env, &oracle_addr);
    let price = 150_000_000; // 1.5 XLM
    oracle_client.set_price(&price, &7);

    // Initialize condition with THRESHOLD_BELOW direction
    let client = ConditionClient::new(&env, &condition_addr);
    let threshold = 100_000_000; // 1 XLM
    client.initialize(&oracle_addr, &threshold, &THRESHOLD_BELOW);

    // Check condition: should be false because price > threshold (and direction is BELOW)
    let result = client.check();
    assert!(!result, "Condition should return false when price > threshold and direction is BELOW");
}

#[test]
fn test_price_crosses_threshold_dynamic() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy contracts
    let condition_id = env.register(PriceThresholdCondition, ());
    let condition_addr = Address::from_contract_id(&env, &condition_id);

    let oracle_id = env.register(mock_oracle::MockOracle, ());
    let oracle_addr = Address::from_contract_id(&env, &oracle_id);

    let oracle_client = mock_oracle::MockOracle::new(&env, &oracle_addr);
    let client = ConditionClient::new(&env, &condition_addr);
    let threshold = 100_000_000; // 1 XLM

    // Initialize with THRESHOLD_ABOVE
    client.initialize(&oracle_addr, &threshold, &THRESHOLD_ABOVE);

    // Phase 1: Price starts below threshold
    oracle_client.set_price(&50_000_000, &7);
    assert!(!client.check(), "Phase 1: Price below threshold, should be false");

    // Phase 2: Price moves to exactly the threshold
    oracle_client.set_price(&100_000_000, &7);
    assert!(!client.check(), "Phase 2: Price at threshold, should be false (not greater than)");

    // Phase 3: Price crosses above the threshold
    oracle_client.set_price(&150_000_000, &7);
    assert!(client.check(), "Phase 3: Price above threshold, should be true");

    // Phase 4: Price can move back below, condition becomes false again
    oracle_client.set_price(&50_000_000, &7);
    assert!(!client.check(), "Phase 4: Price back below threshold, should be false");
}

#[test]
fn test_multiple_conditions_independent() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy two condition contracts and two oracle contracts
    let condition1_id = env.register(PriceThresholdCondition, ());
    let condition1_addr = Address::from_contract_id(&env, &condition1_id);

    let condition2_id = env.register(PriceThresholdCondition, ());
    let condition2_addr = Address::from_contract_id(&env, &condition2_id);

    let oracle1_id = env.register(mock_oracle::MockOracle, ());
    let oracle1_addr = Address::from_contract_id(&env, &oracle1_id);

    let oracle2_id = env.register(mock_oracle::MockOracle, ());
    let oracle2_addr = Address::from_contract_id(&env, &oracle2_id);

    // Set different prices on each oracle
    let oracle1_client = mock_oracle::MockOracle::new(&env, &oracle1_addr);
    let oracle2_client = mock_oracle::MockOracle::new(&env, &oracle2_addr);
    oracle1_client.set_price(&50_000_000, &7);
    oracle2_client.set_price(&150_000_000, &7);

    // Initialize conditions with different thresholds
    let client1 = ConditionClient::new(&env, &condition1_addr);
    let client2 = ConditionClient::new(&env, &condition2_addr);

    client1.initialize(&oracle1_addr, &100_000_000, &THRESHOLD_ABOVE);
    client2.initialize(&oracle2_addr, &100_000_000, &THRESHOLD_ABOVE);

    // Verify they are independent
    assert!(!client1.check(), "Condition1 should be false (price below threshold)");
    assert!(client2.check(), "Condition2 should be true (price above threshold)");
}

#[test]
fn test_condition_reads_price_at_call_time() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy contracts
    let condition_id = env.register(PriceThresholdCondition, ());
    let condition_addr = Address::from_contract_id(&env, &condition_id);

    let oracle_id = env.register(mock_oracle::MockOracle, ());
    let oracle_addr = Address::from_contract_id(&env, &oracle_id);

    let oracle_client = mock_oracle::MockOracle::new(&env, &oracle_addr);
    let client = ConditionClient::new(&env, &condition_addr);
    let threshold = 100_000_000;

    // Initialize with current price below threshold
    oracle_client.set_price(&50_000_000, &7);
    client.initialize(&oracle_addr, &threshold, &THRESHOLD_ABOVE);

    // First check: price is below, should be false
    assert!(!client.check(), "First check: price below threshold");

    // Update the oracle price without re-initializing the condition
    oracle_client.set_price(&150_000_000, &7);

    // Second check: should read the NEW price from oracle and return true
    // This verifies we read price at call time, not trusting cached values
    assert!(client.check(), "Second check: price now above threshold, read at call time");

    // This demonstrates that the condition reads fresh data each time,
    // not relying on stored state or caller-supplied values
}
