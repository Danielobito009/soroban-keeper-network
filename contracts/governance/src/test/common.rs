//! Common test setup and utilities.

use soroban_sdk::{
    testutils::{Address as _, Deployer as _, Events as _},
    token, Address, Env,
};

use crate::Governance;

/// Test harness with initialized governance contract and mock token.
pub struct TestEnv {
    pub env: Env,
    pub governance: crate::Governance,
    pub gov_address: Address,
    pub token_id: Address,
}

/// Set up a test environment with governance contract and KPRS token mock.
pub fn setup() -> TestEnv {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimator().budget().reset_unlimited();

    // Create governance contract.
    let gov_address = env.register_contract(None, Governance);
    let governance = crate::Governance::new(&env, &gov_address);

    // Create mock token.
    let token_id = env.register_stellar_asset_contract(Address::generate(&env));

    // Initialize governance.
    governance
        .initialize(&token_id)
        .expect("governance initialization failed");

    TestEnv {
        env,
        governance,
        gov_address,
        token_id,
    }
}

/// Advance the simulated ledger by `ledgers` and optionally adjust timestamps.
/// Mirrors keeper-registry's advance pattern (issue 0122, 0312, 0332).
pub fn advance(env: &Env, ledgers: u32) {
    for _ in 0..ledgers {
        env.ledger()
            .with_mut(|l| {
                l.sequence = l.sequence.saturating_add(1);
            });
    }
}

/// Get a voter with a specific KPRS token balance.
pub fn voter_with_balance(env: &Env, token_id: &Address, balance: i128) -> Address {
    let voter = Address::generate(env);
    let token = token::StellarAssetClient::new(env, token_id);
    token.mint(&voter, &balance);
    voter
}
