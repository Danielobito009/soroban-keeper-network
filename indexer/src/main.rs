//! Indexer entry point.
//!
//! Startup order matters: configuration is validated before anything connects,
//! so a misconfigured deployment fails immediately with the full list of
//! problems rather than part-way through its first poll.

use anyhow::{Context, Result};
use keeper_indexer::rpc::HttpClient;
use keeper_indexer::service::shutdown_signal;
use keeper_indexer::{Config, Service, Store};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("INDEXER_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(err) => {
            // Every problem at once, so one restart is enough to fix them all.
            eprintln!("{err}");
            std::process::exit(2);
        }
    };

    tracing::info!(
        rpc_url = %config.rpc_url,
        contract_id = %config.contract_id,
        start_ledger = config.start_ledger,
        "starting keeper indexer"
    );

    let source = HttpClient::new(&config.rpc_url);
    // A wrong INDEXER_RPC_URL should stop the boot, not surface as a failed
    // poll a few seconds in.
    source
        .get_health()
        .await
        .context("checking the Soroban RPC endpoint")?;

    let store = Store::connect(&config.database_url)
        .await
        .context("opening the event store")?;

    let service = Service::new(config, source, store);
    let listener = service.bind().await?;
    tracing::info!(address = %listener.local_addr()?, "serving the /v1 API");

    // A returned error is a failed ingestion or HTTP task. Exiting non-zero
    // (rather than leaving the other half running) is what lets a process
    // supervisor notice and restart; ingestion resumes from its checkpoint.
    service
        .run(listener, shutdown_signal())
        .await
        .context("keeper indexer stopped")?;
    tracing::info!("shut down cleanly");

    Ok(())
}
