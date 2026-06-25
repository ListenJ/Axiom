use thiserror::Error;

#[derive(Error, Debug, Clone)]
pub enum OpenClawError {
    #[error("IO error: {0}")]
    Io(String),
    #[error("Search error: {0}")]
    Search(String),
    #[error("Route error: {0}")]
    Route(String),
    #[error("Cache error: {0}")]
    Cache(String),
    #[error("Vault error: {0}")]
    Vault(String),
    #[error("Config error: {0}")]
    Config(String),
    #[error("Database error: {0}")]
    Database(String),
    #[error("Network error: {0}")]
    Network(String),
    #[error("Serialization error: {0}")]
    Serialization(String),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Unauthorized")]
    Unauthorized,
    #[error("Rate limited")]
    RateLimited,
    #[error("Timeout")]
    Timeout,
    #[error("Unknown: {0}")]
    Unknown(String),
}

pub type Result<T> = std::result::Result<T, OpenClawError>;

impl From<std::io::Error> for OpenClawError {
    fn from(e: std::io::Error) -> Self {
        OpenClawError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for OpenClawError {
    fn from(e: serde_json::Error) -> Self {
        OpenClawError::Serialization(e.to_string())
    }
}
