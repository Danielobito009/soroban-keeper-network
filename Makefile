# Soroban Keeper Network — common developer commands.
# Run `make help` for the list.
#
# IMPORTANT: The `ci` target must stay in sync with the required jobs in
# .github/workflows/ci.yml (format, test, build-wasm, sdk-ts, bot, bot-v2,
# indexer, rust-sdk, indexer-client). Change one, change the other.

WASM := target/wasm32-unknown-unknown/release/keeper_registry.wasm

.PHONY: help build test fmt fmt-check lint wasm optimize clean bot bot-test bot-v2-test sdk-ts sdk-ts-lint cli indexer rust-sdk indexer-client ci check

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build: ## Build the workspace
	cargo build

test: ## Run the contract test suite (matches CI)
	cargo test --workspace --locked

fmt: ## Format all Rust code
	cargo fmt --all

fmt-check: ## Check formatting (matches CI)
	cargo fmt --all -- --check

lint: ## Run clippy with warnings denied (stricter than CI)
	cargo clippy --all-targets -- -D warnings

wasm: ## Build the release WASM contracts (matches CI)
	cargo build --locked --release --target wasm32-unknown-unknown --package keeper-registry
	cargo build --locked --release --target wasm32-unknown-unknown --package keeper-treasury
	cargo build --locked --release --target wasm32-unknown-unknown --package time-window-condition

optimize: wasm ## Build and optimize the WASM for deployment
	stellar contract optimize --wasm $(WASM)

bot: ## Run the example keeper bot
	cd examples/keeper-bot && npm start

indexer: ## Format-check, build and test the indexer (matches CI)
	cargo fmt --package keeper-indexer -- --check
	cargo build --package keeper-indexer --locked
	cargo test --package keeper-indexer --locked

sdk-ts: ## Typecheck, build and test the TypeScript SDK (matches the required CI job)
	cd packages/sdk-ts && npm ci --no-audit --no-fund && npx tsc --noEmit -p tsconfig.json && npm run build && npm test

sdk-ts-lint: ## ESLint the TypeScript SDK (advisory in CI, so not part of `make ci`)
	cd packages/sdk-ts && npm ci --no-audit --no-fund && npm run lint

cli: sdk-ts ## Build and test the skn CLI (needs the SDK build)
	cd packages/cli && npm install --no-audit --no-fund && npm run build && npm test

bot-test: sdk-ts ## Build the SDK then run the keeper bot's tests (matches CI) — bot depends on sdk-ts's dist/ output
	cd examples/keeper-bot && npm ci --no-audit --no-fund && npm test && npm run lint

bot-v2-test: sdk-ts ## Build the SDK then build, test and lint keeper-bot-v2 (matches CI)
	cd examples/keeper-bot-v2 && npm ci --no-audit --no-fund && npm run build && npm test && npm run lint

rust-sdk: ## Test the Rust SDK crate (matches CI)
	cargo test --package soroban-keeper-sdk --locked

indexer-client: ## Typecheck, build, test and lint the indexer client (matches CI)
	cd packages/indexer-client && npm ci --no-audit --no-fund && npx tsc --noEmit -p tsconfig.json && npm run build && npm test && npm run lint

clean: ## Remove build artifacts
	cargo clean

ci: fmt-check test wasm sdk-ts bot-test bot-v2-test indexer rust-sdk indexer-client ## Run all required CI checks locally (blocking checks only)

check: ci lint sdk-ts-lint ## Run all checks contributors should run before opening a PR
