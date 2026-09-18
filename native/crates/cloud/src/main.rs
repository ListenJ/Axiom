use axum::{
    extract::{Query, State},
    http::{HeaderValue, StatusCode},
    response::Json,
    routing::{get, post},
    Router,
};
use clap::Parser;
use deadpool_postgres::{Config, Pool, Runtime};
use oc_route::RouterEngine;
use oc_search::DeterministicEngine;
use oc_shared::types::{DeploymentEdition, SearchOptions, SystemStatus};
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio_postgres::NoTls;
use tracing::{info, warn};

#[derive(Parser, Debug)]
#[command(name = "Axiom-cloud", version = "2.3.0")]
struct Args {
    #[arg(short, long, default_value = "18789")]
    port: u16,
    #[arg(short, long, default_value = "0.0.0.0")]
    bind: String,
    #[arg(long, default_value = "./Axiom-memory")]
    vault_path: String,
    #[arg(long, env = "DATABASE_URL")]
    database_url: Option<String>,
    #[arg(long, env = "REDIS_URL", default_value = "redis://127.0.0.1:6379")]
    redis_url: String,
    #[arg(long, default_value = "info")]
    log_level: String,
    #[arg(long, default_value = "4")]
    workers: usize,
}

struct AppState {
    search: Arc<DeterministicEngine>,
    router: Arc<RouterEngine>,
    pg_pool: Option<Pool>,
    redis: Option<ConnectionManager>,
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

fn default_limit() -> usize { 20 }

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    edition: String,
    version: &'static str,
    distributed: bool,
    cache_backend: String,
}

fn build_cors_layer() -> tower_http::cors::CorsLayer {
    let raw = std::env::var("AXIOM_CLOUD_CORS")
        .unwrap_or_else(|_| "http://localhost:18789,http://127.0.0.1:18789".to_string());
    let origins: Vec<HeaderValue> = raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| match HeaderValue::from_str(s) {
            Ok(v) => Some(v),
            Err(e) => {
                warn!("Ignoring invalid AXIOM_CLOUD_CORS origin {:?}: {}", s, e);
                None
            }
        })
        .collect();
    tower_http::cors::CorsLayer::new()
        .allow_origin(tower_http::cors::AllowOrigin::list(origins))
        .allow_methods(tower_http::cors::AllowMethods::any())
        .allow_headers(tower_http::cors::AllowHeaders::any())
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| format!("Axiom_cloud={},tower_http=warn", args.log_level).into()),
        )
        .with_target(false)
        .json()
        .init();

    info!("Axiom Cloud Edition v2.3.0 starting...");
    info!("Workers: {}", args.workers);
    info!("Vault path: {}", args.vault_path);

    // PostgreSQL pool
    let pg_pool = if let Some(ref url) = args.database_url {
        let mut cfg = Config::new();
        cfg.url = Some(url.clone());
        match cfg.create_pool(Some(Runtime::Tokio1), NoTls) {
            Ok(pool) => {
                info!("PostgreSQL pool created");
                Some(pool)
            }
            Err(e) => {
                warn!("PostgreSQL pool failed: {}", e);
                None
            }
        }
    } else {
        warn!("No DATABASE_URL provided  -- running without PostgreSQL");
        None
    };

    // Redis connection
    let redis_client = match redis::Client::open(args.redis_url.clone()) {
        Ok(client) => match ConnectionManager::new(client).await {
            Ok(cm) => {
                info!("Redis connected");
                Some(cm)
            }
            Err(e) => {
                warn!("Redis connection failed: {}", e);
                None
            }
        },
        Err(e) => {
            warn!("Redis client init failed: {}", e);
            None
        }
    };

    let search = Arc::new(DeterministicEngine::new(args.vault_path.clone()));
    let router = Arc::new(RouterEngine::new());

    let state = Arc::new(AppState {
        search,
        router,
        pg_pool,
        redis: redis_client,
        edition: DeploymentEdition::Cloud,
        start_time: std::time::Instant::now(),
    });

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/search", get(search_handler))
        .route("/stats", get(stats_handler))
        .route("/native/search", post(native_search_handler))
        .route("/native/router/perf", get(router_perf_handler))
        .route("/native/cache/stats", get(cache_stats_handler))
        .route("/native/cluster/status", get(cluster_status_handler))
        .with_state(state)
        .layer(build_cors_layer())
        .layer(tower_http::compression::CompressionLayer::new())
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(tower::limit::ConcurrencyLimitLayer::new(args.workers * 1000));

    let addr: SocketAddr = format!("{}:{}", args.bind, args.port)
        .parse()
        .expect("Invalid bind address");

    info!("Cloud server listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health_handler(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        edition: state.edition.to_string(),
        version: "2.3.0",
        distributed: state.redis.is_some() && state.pg_pool.is_some(),
        cache_backend: if state.redis.is_some() { "redis" } else { "memory" }.to_string(),
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
            include_recency: false,
    };

    let results = state.search.search(&params.q, &opts);

    Ok(Json(serde_json::json!({
        "query": params.q,
        "count": results.len(),
        "results": results,
        "edition": "cloud",
    })))
}

async fn stats_handler(State(state): State<Arc<AppState>>) -> Json<SystemStatus> {
    let stats = state.search.stats();
    Json(SystemStatus {
        version: "2.3.0".to_string(),
        edition: "cloud".to_string(),
        uptime_secs: state.start_time.elapsed().as_secs(),
        memory_mb: 0,
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
            include_recency: false,
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

async fn cache_stats_handler(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let redis_info = if let Some(ref mut _redis) = state.redis.as_ref() {
        // Cannot use &mut on shared ref; skip for now
        serde_json::json!(null)
    } else {
        serde_json::json!(null)
    };
    Json(serde_json::json!({
        "redis": redis_info,
        "router_cache_size": state.router.get_perf_report().len(),
    }))
}

async fn cluster_status_handler(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let pg_status = if let Some(ref pool) = state.pg_pool {
        match pool.get().await {
            Ok(_) => "connected",
            Err(_) => "error",
        }
    } else {
        "disabled"
    };

    let redis_status = if state.redis.is_some() { "connected" } else { "disabled" };

    Json(serde_json::json!({
        "postgresql": pg_status,
        "redis": redis_status,
        "distributed_ready": state.redis.is_some() && state.pg_pool.is_some(),
    }))
}

