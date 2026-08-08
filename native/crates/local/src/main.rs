use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use clap::Parser;
use oc_route::RouterEngine;
use oc_search::DeterministicEngine;
use oc_shared::types::{
    DeploymentEdition, SearchOptions, SystemStatus,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tracing::info;

#[derive(Parser, Debug)]
#[command(name = "Axiom-local", version = "2.3.0")]
struct Args {
    #[arg(short, long, default_value = "18789")]
    port: u16,
    #[arg(short, long, default_value = "127.0.0.1")]
    bind: String,
    #[arg(short, long, default_value = "./Axiom-memory")]
    vault_path: String,
    #[arg(long, default_value = "./data/agent.db")]
    db_path: String,
    #[arg(long, default_value = "info")]
    log_level: String,
}

struct AppState {
    search: Arc<DeterministicEngine>,
    router: Arc<RouterEngine>,
    edition: DeploymentEdition,
    start_time: std::time::Instant,
}

#[derive(Deserialize)]
struct SearchParams {
    q: String,
    #[serde(default = "default_limit")]
    limit: usize,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    para: Option<String>,
}

fn default_limit() -> usize { 10 }

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    edition: String,
    version: &'static str,
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| format!("Axiom_local={},tower_http=warn", args.log_level).into()),
        )
        .with_target(false)
        .with_thread_ids(false)
        .compact()
        .init();

    info!("Axiom Local Edition v2.3.0 starting...");
    info!("Vault path: {}", args.vault_path);
    info!("Database: {}", args.db_path);

    let search = Arc::new(DeterministicEngine::new(args.vault_path.clone()));
    let router = Arc::new(RouterEngine::new());

    let state = Arc::new(AppState {
        search,
        router,
        edition: DeploymentEdition::Local,
        start_time: std::time::Instant::now(),
    });

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/search", get(search_handler))
        .route("/stats", get(stats_handler))
        .route("/native/search", post(native_search_handler))
        .route("/native/router/perf", get(router_perf_handler))
        .with_state(state)
        .layer(tower_http::cors::CorsLayer::permissive())
        .layer(tower_http::compression::CompressionLayer::new())
        .layer(tower_http::trace::TraceLayer::new_for_http());

    let addr: SocketAddr = format!("{}:{}", args.bind, args.port)
        .parse()
        .expect("Invalid bind address");

    info!("Server listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health_handler(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        edition: state.edition.to_string(),
        version: "2.3.0",
    })
}

async fn search_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SearchParams>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let opts = SearchOptions {
        limit: params.limit,
        types: None,
        tags: params.tags,
        para_category: params.para,
        date_range: None,
        include_reasons: true,
    };

    let results = state.search.search(&params.q, &opts);

    Ok(Json(serde_json::json!({
        "query": params.q,
        "count": results.len(),
        "results": results,
        "edition": "local",
    })))
}

async fn stats_handler(State(state): State<Arc<AppState>>) -> Json<SystemStatus> {
    let stats = state.search.stats();
    Json(SystemStatus {
        version: "2.3.0".to_string(),
        edition: "local".to_string(),
        uptime_secs: state.start_time.elapsed().as_secs(),
        memory_mb: 0, // TODO: sysinfo
        cpu_percent: 0.0,
        vault_notes: stats.get("total_notes").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
        active_connections: 0,
    })
}

#[derive(Deserialize)]
struct NativeSearchReq {
    query: String,
    #[serde(default = "default_limit")]
    limit: usize,
}

async fn native_search_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<NativeSearchReq>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let opts = SearchOptions {
        limit: req.limit,
        types: None,
        tags: None,
        para_category: None,
        date_range: None,
        include_reasons: true,
    };
    let results = state.search.search(&req.query, &opts);
    Ok(Json(serde_json::json!({
        "native": true,
        "latency_us": 0,
        "results": results,
    })))
}

async fn router_perf_handler(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let report = state.router.get_perf_report();
    let hotspots = state.router.get_hotspot_report();
    Json(serde_json::json!({
        "endpoints": report,
        "hotspots": hotspots,
    }))
}

