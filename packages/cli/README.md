# skn

`skn` is the command-line tool for the Soroban Keeper Network: deploying the
keeper registry and treasury contracts, registering tasks (single or batch),
inspecting protocol state, and running admin operations.

This package is built on [`@soroban-keeper-network/sdk`](../sdk-ts).

## Commands

- `skn --help` — list all command groups and global flags
- `skn --version` — print the CLI version and supported contract `VERSION` range
- `skn config init [--force]` — write a config file with `testnet`, `futurenet`, and `mainnet` profiles
- `skn config show` — print effective configuration and signing-key source (never the secret)
- `skn inspect [summary | version]` — read-only protocol state summary and SDK compatibility check
- `skn admin <pause|unpause|set-fee-bps|set-min-reward|set-min-stake|set-dispute-window|sweep-fees>` — admin operations with pre-flight admin verification, current/new value display, and confirmation
- `skn task <register|cancel|expire|increase-reward|extend-deadline>` — manage a task as its owner (see [Task commands](#task-commands))
- `skn keeper <balance|withdraw|stake|unbond|withdraw-stake|unbonding>` — a keeper's balance, stake and rewards (see [Keeper commands](#keeper-commands))
- `skn batch register <tasks.json|tasks.csv> [--dry-run]` — batch task registration with local pre-flight validation and automatic chunking by `max_batch_size`
- `skn deploy [registry|treasury|all]` — upload WASM, deploy, initialize, and save contract IDs to the selected profile

## Task commands

Amounts are in the reward token's smallest unit (stroops for XLM). Times are Unix seconds or ISO 8601 (`2030-01-01T00:00:00Z`). Every task command signs as the owner and ends by printing the task's state as read back from the registry.

```sh
skn task register --type liquidation --reward 5000000 --deadline 2030-01-01T00:00:00Z \
    --ttl-ledgers 17280 --lock-ledgers 100 [--calldata 0a1b] [--verifier C...]
skn task cancel <task-id>
skn task expire <task-id>
skn task increase-reward <task-id> --by <amount>
skn task extend-deadline <task-id> --to <time>
```

- `cancel` works on a pending task, or on a claimed task whose lock has lapsed. If the lock is still live it exits `4` and says who holds the task and when the lock lapses (the ledger, and roughly how long from now). A task that is already executed, cancelled or expired reports that it can never be cancelled.
- `expire` can be run by any account; the signing key only pays the fee.

## Keeper commands

```sh
skn keeper balance [--keeper G...]   # reward balance, bonded stake, unbonding, effective reputation
skn keeper withdraw                  # withdraw the signing keeper's reward balance
skn keeper stake <amount>            # deposit collateral
skn keeper unbond <amount>           # start the unbonding delay
skn keeper unbonding [--keeper G...] # the pending unbond request
skn keeper withdraw-stake            # release the unbonded stake
```

- `balance` defaults to the signing key's address when `--keeper` is not given, and then needs no signing key if `--keeper` is. Reputation is the contract's `effective_reputation`, decayed to the current ledger, shown as a percentage with executed and missed counts. If the registry has no such view, the rest still prints and a warning says so.
- `withdraw` checks the balance first. A zero balance prints "Nothing to withdraw" and sends no transaction.
- `unbond` prints the ledger at which the stake becomes withdrawable, with a rough wait and time. Only one unbond request can be pending at a time.
- `withdraw-stake` before the unlock ledger exits `4` with `UnbondNotReady`, the remaining wait, and the words "Nothing was sent". It also checks that there is a request to withdraw at all.

All of these refuse to send on mainnet without `--confirm-mainnet`, except where nothing would be sent.

## Signing keys

Keys are resolved in precedence order and are never echoed to stdout, stderr, or logs:

1. `--key-file <path>` (refused on POSIX if readable by group/others)
2. `--identity <name>` (from `~/.config/stellar/identity/<name>.toml`)
3. `SKN_SECRET_KEY` environment variable

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Unexpected internal failure |
| `2` | Usage, configuration, settings, or key error |
| `3` | RPC or network error |
| `4` | Contract error |
| `5` | Not found |
