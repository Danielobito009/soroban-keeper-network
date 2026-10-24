# Deploying & Running the Indexer

How to stand up an indexer instance: what it needs, how to provision its
database, how to run the initial backfill, and what a healthy steady state
looks like.

This document is about *operating* an indexer. For what the indexer is, how
its schema is laid out, and why it stores history rather than mutable current
state, see [`INDEXER_DESIGN.md`](INDEXER_DESIGN.md) — that is the reference
for the design, and this guide does not restate it.

> **Note:** ingest, storage, reorg, backfill, and API-shape decisions from
> issue #346 still land in `INDEXER_DESIGN.md` as that issue closes. Until
> they do, the SQL in `indexer/migrations/` is the reference for tables and
> columns. The instance model and event-versioning policy are already recorded
> there.

## One instance per deployment

One indexer process tracks exactly one registry contract, on one network.
That is a design decision ([`INDEXER_DESIGN.md` §1](INDEXER_DESIGN.md#1-one-instance-per-registry-deployment)),
not a current limitation that configuration can work around.

- **One `(network, contract id)` pair → one process, one database.** Testnet,
  futurenet, and mainnet each get their own instance. A second mainnet
  deployment after an upgrade or migration is a new pair, so it gets a new
  instance too.
- **Do not point two instances at the same database.** The schema has no
  contract-id column and the ingest checkpoint is a single row; two writers
  would share a cursor and mix unrelated history.
- **The contract id is a single `C...` value**, not a list. There is no
  supported way to pass several ids to one process.

An in-place WASM `upgrade` of the *same* contract id is still one
deployment: keep the same instance, same database, resume from the
checkpoint. The event-versioning policy in
[`INDEXER_DESIGN.md` §2](INDEXER_DESIGN.md#2-event-shape-changes-across-contract-version)
covers what happens to already-ingested rows and when a breaking event-shape
change instead means starting a new instance.

## Prerequisites

- **Somewhere to keep a SQLite file.** The indexer uses SQLite and nothing
  else; there is no database server to install. Put the file on a persistent
  volume, because it holds the checkpoint as well as the events.
- **A Rust toolchain**, to build the indexer binary (`cargo build --release
  --package keeper-indexer`).
- **An RPC endpoint** for the network the registry is deployed on, with
  retention covering the ledger range you intend to backfill (see
  [Initial backfill](#3-initial-backfill)).
- **The deployed registry contract ID** (`C...`) you want to index.

## 1. Provision storage

There is nothing to create: the indexer makes the database file on first start
if it does not exist. Pick a directory the service user can write to and keep
it out of any path that is wiped on deploy.

```bash
install -d -o indexer -g indexer -m 0750 /var/lib/keeper-indexer
```

The file is then `sqlite:///var/lib/keeper-indexer/indexer.db` (note the three
slashes for an absolute path).

Sizing is driven by task events, not by the admin trail: admin and governance
events are low-volume by nature, while claims and executions grow with network
activity. Plan capacity against your expected task throughput, and note that
every event is retained — the indexer never deletes history to reclaim space.

## 2. Configuration

The indexer is configured through the environment:

| Variable | Required | Meaning |
|----------|----------|---------|
| `INDEXER_DATABASE_URL` | Yes | `sqlite:///var/lib/keeper-indexer/indexer.db` |
| `INDEXER_RPC_URL` | Yes | The Soroban RPC endpoint to read events from. |
| `INDEXER_CONTRACT_ID` | Yes | The single `C...` contract whose events are indexed. One id, not a list; a second contract is a second instance. |
| `INDEXER_START_LEDGER` | Yes | First ledger to backfill from on a fresh database. Use the contract's deployment ledger. |
| `INDEXER_BIND_ADDRESS` | No | Where the API listens. Default `127.0.0.1:8080`. |

Everything else (poll interval, page size, cache TTL, rate limits, log filter)
is optional and listed in [`indexer/README.md`](../indexer/README.md).

Keep the database path out of the process table if it reveals anything
sensitive. A systemd unit's `EnvironmentFile=` with mode `0600`, or your
platform's secret store, is the usual way.

## 3. Initial backfill

On an empty database the indexer replays history from `INDEXER_START_LEDGER`
forward before it settles into following the chain head. This is the longest
part of a deployment and the part most likely to need a second attempt, so
watch the first run:

```bash
INDEXER_DATABASE_URL=sqlite://indexer.db \
INDEXER_RPC_URL=... INDEXER_CONTRACT_ID=C... INDEXER_START_LEDGER=... \
  ./target/release/keeper-indexer
```

There is no separate backfill mode. The same process backfills, then keeps
polling, and serves the API the whole time. `GET /v1/health` reports
`last_ingested_ledger` and `backfill_complete`, so you can tell when it has
caught up.

The backfill is **resumable and safe to re-run**. Progress is checkpointed
after every page. Every event is keyed on `(tx_hash, event_index)` and inserts
are idempotent, so re-ingesting a range that was already processed is a no-op
rather than a duplicate. If it dies partway, start it again — it resumes from
the checkpoint and does not need the database reset first.

Stop it with SIGINT or SIGTERM. It finishes and checkpoints the page it is on,
then exits `0`. Any other exit is a failure and the reason is in the log; run
the service under a supervisor that restarts it.

## 4. Steady-state operation

A healthy instance looks like this:

- **Ingestion lag is small and flat.** Lag is the distance between the latest
  ledger the indexer has ingested and the current chain head. It should sit at
  a few ledgers and stay there. A number that grows monotonically is the
  signal that matters — see the troubleshooting section.
- **`/v1/health` reports `backfill_complete: true`** and a
  `last_ingested_ledger` that keeps advancing. Compare it with the chain head
  from your RPC endpoint (`getLatestLedger`).
- **Derived state agrees with the contract.** For a task, the status from
  `GET /v1/tasks/{id}` must match the contract's own `get_task` view whenever
  the indexer is caught up. A disagreement means the indexer is behind or has
  missed events; it does not mean the contract is wrong.
- **The admin trail is append-only.** Row counts in the `events` table only ever
  increase. A count that drops means something outside the indexer wrote to
  the database.

Back up the database like any other stateful service. The data is
reconstructible from chain by re-running the backfill, so a backup is a
recovery-time optimization rather than the only copy — but a full re-backfill
is slow enough that you want the backup.

## Troubleshooting

### Backfill stuck partway

The ingested ledger stops advancing while the backfill is running.

Check the RPC endpoint first. The most common cause is that it does not retain
history as far back as `START_LEDGER`: public endpoints often keep a limited
window, and a request for an older ledger fails rather than returning an empty
result. Point at an endpoint with full history, or raise `START_LEDGER` and
accept that events before it are not indexed.

If the endpoint is fine, the backfill is safe to simply restart — it resumes
from what is already stored and re-ingesting overlapping ledgers is a no-op.
Do **not** drop the tables to "start clean"; that turns a resumable job into a
full replay.

### Ingestion lag growing

Lag increases steadily instead of holding flat, meaning the indexer is
consuming ledgers slower than the network produces them.

In order of likelihood:

1. **The database is the bottleneck.** SQLite allows one writer at a time, so
   slow storage (a network filesystem in particular) or another process
   opening the same file will show up here first. Keep the file on local disk
   and let only the indexer write to it.
2. **The RPC endpoint is rate-limiting or slow.** A shared public endpoint
   under load will throttle. Move to a dedicated endpoint.
3. **A restart loop.** If the process is crashing and restarting, lag grows
   between restarts even though each run makes progress. Check the service
   logs before assuming a throughput problem.

Lag that is large but *flat* after a restart or an outage is not this problem
— that is the indexer catching up, and it will close on its own.

### The database cannot be opened

The process exits at startup with `opening the event store`.

Check the path in `INDEXER_DATABASE_URL`: the directory must exist and be
writable by the user the service runs as (the indexer creates the file, not
the directory), and an absolute path needs three slashes
(`sqlite:///var/...`). If the file is on a network filesystem, move it to local
disk; SQLite's locking is unreliable there.

An error while the service is running does not corrupt what is already stored —
the indexer resumes from the last committed checkpoint.

### The process exited

An exit with a non-zero status always means ingestion or the API server
failed; the log line names which. The process does not keep half of itself
running. The usual causes are an unreachable or erroring RPC endpoint, and a
ledger the RPC later reports differently from what was stored (see
`indexer/src/reorg.rs`), which needs a person to look at it rather than a
blind restart.
