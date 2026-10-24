//! Process-level tests: the real `keeper-indexer` binary, a mock Soroban RPC,
//! and the real HTTP and WebSocket listener.
//!
//! Nothing here calls into the library. The binary is started the way an
//! operator starts it (environment variables only), fed fixture events over
//! JSON-RPC as XDR, and queried over its public routes. That is the only way
//! to catch `main` not wiring something the library supports.

#![cfg(unix)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use futures::StreamExt;
use serde_json::{json, Value};
use stellar_xdr::curr::{
    AccountId, Int128Parts, Limits, PublicKey, ScAddress, ScSymbol, ScVal, ScVec, Uint256, WriteXdr,
};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};

const CONTRACT_ID: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const TIP: u32 = 12;
const WAIT: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct MockRpc {
    /// When set, `getEvents` answers with a JSON-RPC error.
    fail_events: Arc<AtomicBool>,
}

fn xdr(val: &ScVal) -> String {
    val.to_xdr_base64(Limits::none()).expect("encode xdr")
}

fn symbol(name: &str) -> ScVal {
    ScVal::Symbol(ScSymbol(name.try_into().expect("symbol")))
}

fn account(byte: u8) -> ScVal {
    ScVal::Address(ScAddress::Account(AccountId(
        PublicKey::PublicKeyTypeEd25519(Uint256([byte; 32])),
    )))
}

/// `TaskRegistered`: topics `(reg, task)`, payload `(id, owner, reward, deadline)`.
fn registered_event(task_id: u64, ledger: u32) -> Value {
    let values = ScVal::Vec(Some(ScVec(
        vec![
            ScVal::U64(task_id),
            account(7),
            ScVal::I128(Int128Parts { hi: 0, lo: 500 }),
            ScVal::U64(9_000),
        ]
        .try_into()
        .expect("vec"),
    )));
    json!({
        "id": format!("{:019}-{:010}", u64::from(ledger) << 32, 1),
        "ledger": ledger,
        "ledgerClosedAt": "2025-01-01T00:00:00Z",
        "txHash": format!("tx-{task_id}"),
        "topic": [xdr(&symbol("reg")), xdr(&symbol("task"))],
        "value": xdr(&values),
    })
}

async fn rpc(State(mock): State<MockRpc>, Json(req): Json<Value>) -> Json<Value> {
    let result = match req["method"].as_str() {
        Some("getHealth") => Ok(json!({ "status": "healthy" })),
        Some("getLatestLedger") => Ok(json!({ "sequence": TIP })),
        Some("getEvents") if mock.fail_events.load(Ordering::SeqCst) => Err("rpc is down"),
        Some("getEvents") => {
            let start = req["params"]["startLedger"].as_u64().unwrap_or(0);
            let events: Vec<Value> = if start <= 10 {
                vec![registered_event(1, 10)]
            } else {
                vec![]
            };
            Ok(json!({ "events": events, "latestLedger": TIP }))
        }
        _ => Err("unknown method"),
    };
    Json(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": req["id"], "result": result }),
        Err(message) => {
            json!({ "jsonrpc": "2.0", "id": req["id"], "error": { "code": -32000, "message": message } })
        }
    })
}

async fn start_rpc(fail_events: bool) -> SocketAddr {
    let state = MockRpc {
        fail_events: Arc::new(AtomicBool::new(fail_events)),
    };
    let app = Router::new().route("/", post(rpc)).with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind rpc");
    let addr = listener.local_addr().expect("rpc addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

/// A port nothing is listening on right now.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("probe port")
        .local_addr()
        .expect("probe addr")
        .port()
}

struct Indexer {
    child: Child,
    api: String,
    db: PathBuf,
}

impl Indexer {
    fn spawn(rpc: SocketAddr, name: &str) -> Self {
        let port = free_port();
        let db =
            std::env::temp_dir().join(format!("keeper-indexer-{name}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&db);

        let child = Command::new(env!("CARGO_BIN_EXE_keeper-indexer"))
            .env_clear()
            .env("INDEXER_RPC_URL", format!("http://{rpc}"))
            .env("INDEXER_CONTRACT_ID", CONTRACT_ID)
            .env("INDEXER_DATABASE_URL", format!("sqlite://{}", db.display()))
            .env("INDEXER_START_LEDGER", "1")
            .env("INDEXER_BIND_ADDRESS", format!("127.0.0.1:{port}"))
            .env("INDEXER_POLL_INTERVAL_SECS", "1")
            .env("INDEXER_CACHE_TTL_SECS", "0")
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn keeper-indexer");

        Self {
            child,
            api: format!("127.0.0.1:{port}"),
            db,
        }
    }

    async fn get_json(&self, path: &str) -> Option<(u16, Value)> {
        let res = reqwest::get(format!("http://{}{path}", self.api))
            .await
            .ok()?;
        let status = res.status().as_u16();
        Some((status, res.json().await.unwrap_or(Value::Null)))
    }

    /// Poll until `ready` accepts the response, failing if the process dies.
    async fn wait_for(&mut self, path: &str, ready: impl Fn(u16, &Value) -> bool) -> Value {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait().expect("poll child") {
                panic!("indexer exited early with {status} while waiting for {path}");
            }
            if let Some((status, body)) = self.get_json(path).await {
                if ready(status, &body) {
                    return body;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {path}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn terminate(&self) {
        let pid = self.child.id().expect("child pid");
        let status = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .expect("run kill");
        assert!(status.success(), "could not signal the indexer");
    }
}

impl Drop for Indexer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.db);
    }
}

#[tokio::test]
async fn ingests_fixture_events_and_serves_them_over_the_real_listener() {
    let rpc = start_rpc(false).await;
    let mut indexer = Indexer::spawn(rpc, "serve");

    // Ingestion runs without anyone asking it to: wait for the walk to reach
    // the mock chain's tip.
    let health = indexer
        .wait_for("/v1/health", |status, body| {
            status == 200 && body["backfill_complete"] == true
        })
        .await;
    assert_eq!(health["last_ingested_ledger"], TIP);

    // REST: the ingested event is queryable.
    let task = indexer
        .wait_for("/v1/tasks/1", |status, _| status == 200)
        .await;
    assert_eq!(
        task["history"][0]["event_type"], "task_registered",
        "{task}"
    );
    assert_eq!(task["task"]["status"], "pending");

    // WebSocket: the live feed is attached on the same listener.
    let (mut socket, _) =
        tokio_tungstenite::connect_async(format!("ws://{}/v1/stream", indexer.api))
            .await
            .expect("websocket upgrade");
    let first = tokio::time::timeout(WAIT, socket.next())
        .await
        .expect("timed out waiting for subscribed frame")
        .expect("socket closed")
        .expect("frame");
    let frame: Value = serde_json::from_str(first.to_text().expect("text frame")).expect("json");
    assert_eq!(frame["kind"], "subscribed");
    drop(socket);

    // SIGTERM is a graceful shutdown: exit 0, and the port is released.
    indexer.terminate();
    let status = tokio::time::timeout(WAIT, indexer.child.wait())
        .await
        .expect("timed out waiting for shutdown")
        .expect("wait");
    assert!(status.success(), "unclean shutdown: {status}");
    assert!(indexer.get_json("/v1/health").await.is_none());
}

#[tokio::test]
async fn an_ingestion_failure_takes_the_whole_process_down() {
    // Healthy at boot, then `getEvents` errors: the API must not be left
    // serving a database that nothing feeds.
    let rpc = start_rpc(true).await;
    let mut indexer = Indexer::spawn(rpc, "fail");

    let status = tokio::time::timeout(WAIT, indexer.child.wait())
        .await
        .expect("indexer kept running after ingestion failed")
        .expect("wait");
    assert!(!status.success(), "expected a failure exit, got {status}");
    assert!(indexer.get_json("/v1/health").await.is_none());
}
