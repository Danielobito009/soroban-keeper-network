# Soroban Keeper Bot v2

A high-performance, modular off-chain keeper bot for the [Soroban Keeper Network](https://github.com/soroban-tooling/soroban-keeper-network).

> [!NOTE]
> If you are a newcomer to Soroban, building a first integration, or exploring the smart contract ABI, start with the introductory single-file bot in [`examples/keeper-bot`](../keeper-bot).
>
> **Keeper Bot v2** is intended for operators running competitive keepers with requirements for concurrency, custom withdrawal schedules, lock-window-aware scheduling, and state persistence.

---

## 🚀 Key Architectural Capabilities

Keeper Bot v2 is intended for competitive operators. For an introductory,
single-file example, start with [`examples/keeper-bot`](../keeper-bot/).

### Concurrent rounds, prioritization, and spend safety (Issues #404, #407)
* Bounded concurrent workers process independent tasks without racing internally.
* Candidate tasks are ranked by estimated net profit so high-value work is evaluated first.
* `MAX_ROUND_SPEND_STROOPS` imposes an independent per-round fee ceiling (default: `5000000` stroops).
* Lost claim races are normal competitive skips, recorded separately from RPC and execution failures.

### Verifier support (Issue #412)
Verifier-aware proof generation is deferred until the on-chain contract exposes a
verifier field, entry points, and validation hooks. The bot does not implement
against a non-existent contract interface.

### Benchmarking (Issue #413)
Run the latency/throughput benchmark against v1 with `npm run benchmark`. The
benchmark report is committed at [`benchmark/REPORT.md`](benchmark/REPORT.md).

### Configuration

| Environment Variable | Description | Default |
|---|---|---|
| `SOROBAN_RPC_URL` | URL of the Soroban RPC node | Required |
| `KEEPER_SECRET_KEY` | Stellar secret key for signing transactions | Required |
| `KEEPER_CONTRACT_ID` | Contract address of KeeperRegistry | Required |
| `MAX_ROUND_SPEND_STROOPS` | Hard ceiling on round transaction fees | `5000000` |
| `MAX_CONCURRENCY` | Maximum concurrent task workers | `4` |
| `MIN_PROFIT_MARGIN_STROOPS` | Minimum net profit required before claiming | `0` |
| `POLL_INTERVAL_MS` | Delay between keeper rounds | `5000` |
| `SIMULATE_EXECUTION` | Enable fallback simulated executor for development | `false` |

### 1. Graceful Shutdown Guarantee Under Concurrency (`src/shutdown.js`)
* **Worker Draining**: When a `SIGINT` or `SIGTERM` signal is received, the bot stops accepting new candidate tasks and drains all active in-flight workers.
* **No Mid-Submission Kills**: Each concurrent worker finishes its current submission and persists its outcome before the process exits.
* **Bounded Maximum Wait**: Uses a configurable maximum drain ceiling (`maxDrainMs`) to prevent a deadlocked worker or hung network connection from blocking shutdown indefinitely.
> **Notice for Newcomers:** This package is **keeper-bot-v2**, engineered specifically for production operators who require concurrent task processing, multi-account transaction submission, persistent state tracking across restarts, Prometheus metrics, and strict startup validation.
>
> If you are exploring the Soroban Keeper Network for the first time or looking for an educational, single-file, zero-dependency walkthrough, please refer to the beginner-friendly [v1 Keeper Bot](../keeper-bot) instead.

---

## Overview

Keeper Bot v2 is a high-throughput, enterprise-ready off-chain daemon for the Soroban Keeper Network. Key features include:

- **Full Startup Configuration Schema Validation**: Performs both per-field validation and cross-field consistency checks (e.g. concurrency limits vs account pool size, profitability margins vs fee ceilings) to fail fast before any runtime operations begin.
- **Per-Task-Type Observability**: Exposes detailed metrics broken down by `task_type` (claimed, executed, skipped counts by reason, and net profit per type) in Prometheus exposition format.
- **Persistent State & Idempotency**: Backed by PostgreSQL (`DATABASE_URL`) to record task outcomes and prevent duplicate claims or executions across restarts.
- **Multi-Account Concurrency**: Distributes tasks across multiple signing accounts in `SIGNING_KEY_POOL` to bypass single-account sequence number serialization.
- **Pluggable Executors**: Discoverable executor modules with automatic metrics registration.
- **Graceful Shutdown**: Stops accepting new work on `SIGINT` or `SIGTERM`, drains in-flight workers, and bounds shutdown time.
- **Lock-Aware Scheduling**: Rechecks claimed tasks at their unlock ledger while continuing normal task discovery.
- **Scheduled and Fee-Aware Withdrawals**: Supports fixed schedules and withdrawal decisions based on network fees.

---

## Quickstart

### Prerequisites
- Node.js >= 18.0.0
- A funded Stellar account (secret key starting with `S...`) or key pool
- PostgreSQL database instance (for persistent task tracking)
- Deployed `KeeperRegistry` contract ID (starting with `C...`)

### Installation & Configuration
```bash
# Install dependencies
npm install

Run linting and the v1/v2 performance benchmark with `npm run lint` and
`npm run benchmark` respectively.

Run linting:
# Copy configuration template
cp .env.example .env

# Build TypeScript
npm run build

# Run tests
npm test

# Run linter
npm run lint

# Start daemon
npm start
```

For migration instructions from v1, see [docs/KEEPER_BOT_V2_MIGRATION.md](../../docs/KEEPER_BOT_V2_MIGRATION.md).

For design rationale and the shutdown, scheduling, and withdrawal architecture, see [docs/KEEPER_BOT_V2_DESIGN.md](../../docs/KEEPER_BOT_V2_DESIGN.md).
