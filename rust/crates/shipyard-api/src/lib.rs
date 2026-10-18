//! The laptop agent's authenticated status and live event API.
//!
//! The token comes from the host application's secure endpoint lookup. This
//! crate keeps it in a request header and does not include it in diagnostics.

mod model;

pub use model::*;

use reqwest::{header, StatusCode, Url};
use serde::Deserialize;
use std::{error::Error as StdError, fmt, time::Duration};
use tokio::{sync::watch, time};

const READ_TIMEOUT: Duration = Duration::from_secs(30);
const STREAM_SILENCE: Duration = Duration::from_secs(45);

#[derive(Debug)]
pub enum ApiError {
    InvalidEndpoint,
    InvalidToken,
    Transport(reqwest::Error),
    Decode(serde_json::Error),
    Http {
        status: StatusCode,
        code: Option<String>,
        message: String,
    },
    StreamSilence,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidEndpoint => write!(f, "invalid agent endpoint"),
            Self::InvalidToken => write!(f, "invalid agent token"),
            Self::Transport(error) => write!(f, "agent transport error: {error}"),
            Self::Decode(error) => write!(f, "invalid agent JSON: {error}"),
            Self::Http {
                status,
                code,
                message,
            } => {
                write!(f, "agent returned {status}")?;
                if let Some(code) = code {
                    write!(f, " ({code})")?;
                }
                write!(f, ": {message}")
            }
            Self::StreamSilence => write!(f, "agent event stream fell silent"),
        }
    }
}

impl StdError for ApiError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match self {
            Self::Transport(error) => Some(error),
            Self::Decode(error) => Some(error),
            _ => None,
        }
    }
}

/// An authenticated connection to the laptop agent. The token is not `Debug`.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: Url,
    authorization: header::HeaderValue,
}

impl Client {
    /// The endpoint is normally `http://127.0.0.1:1378`. Credentials, a query,
    /// and a path are rejected so API routes stay anchored at the agent origin.
    pub fn new(endpoint: &str, token: &str) -> Result<Self, ApiError> {
        let base = Url::parse(endpoint).map_err(|_| ApiError::InvalidEndpoint)?;
        if !matches!(base.scheme(), "http" | "https")
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || base.path() != "/"
        {
            return Err(ApiError::InvalidEndpoint);
        }
        if token.is_empty() {
            return Err(ApiError::InvalidToken);
        }
        let mut authorization = header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| ApiError::InvalidToken)?;
        authorization.set_sensitive(true);
        Ok(Self {
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(ApiError::Transport)?,
            base,
            authorization,
        })
    }

    fn request(&self, path: &str) -> reqwest::RequestBuilder {
        let url = self.base.join(path).expect("fixed API path is valid");
        self.http
            .get(url)
            .header(header::AUTHORIZATION, self.authorization.clone())
    }

    /// Read the current status with the same 30 second read limit as the app.
    pub async fn status(&self) -> Result<Status, ApiError> {
        let response = self
            .request("v1/status")
            .timeout(READ_TIMEOUT)
            .send()
            .await
            .map_err(ApiError::Transport)?;
        let response = check_response(response).await?;
        let body = response.bytes().await.map_err(ApiError::Transport)?;
        serde_json::from_slice(&body).map_err(ApiError::Decode)
    }

    /// Open the authenticated SSE feed. Each call creates a fresh connection.
    pub async fn events(&self) -> Result<EventStream, ApiError> {
        let response = time::timeout(
            STREAM_SILENCE,
            self.request("v1/events")
                .header(header::ACCEPT, "text/event-stream")
                .send(),
        )
        .await
        .map_err(|_| ApiError::StreamSilence)?
        .map_err(ApiError::Transport)?;
        Ok(EventStream {
            response: time::timeout(STREAM_SILENCE, check_response(response))
                .await
                .map_err(|_| ApiError::StreamSilence)??,
            pending: Vec::new(),
            data: Vec::new(),
        })
    }

    /// Follow the feed until `stop` becomes true. `on_connect` runs on every
    /// connection so the caller can refresh state missed during a disconnect.
    pub async fn follow_events<C, E>(
        &self,
        mut stop: watch::Receiver<bool>,
        mut on_connect: C,
        mut on_event: E,
    ) where
        C: FnMut(),
        E: FnMut(Event),
    {
        let mut attempt = 0_u32;
        while !*stop.borrow() {
            let connected = tokio::select! {
                result = self.events() => result,
                _ = stop.changed() => break,
            };
            if let Ok(mut stream) = connected {
                attempt = 0;
                on_connect();
                loop {
                    let next = tokio::select! {
                        result = stream.next_event() => result,
                        _ = stop.changed() => return,
                    };
                    match next {
                        Ok(Some(event)) => on_event(event),
                        Ok(None) | Err(_) => break,
                    }
                }
            }
            attempt = attempt.saturating_add(1);
            tokio::select! {
                _ = time::sleep(reconnect_delay(attempt)) => {},
                _ = stop.changed() => break,
            }
        }
    }
}

fn reconnect_delay(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(5);
    let base = (500_u64 << exponent).min(10_000);
    Duration::from_millis((base as f64 * fastrand::f64().mul_add(0.4, 0.8)).round() as u64)
}

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<String>,
    code: Option<String>,
}

async fn check_response(response: reqwest::Response) -> Result<reqwest::Response, ApiError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let text = response.text().await.map_err(ApiError::Transport)?;
    let body = serde_json::from_str::<ErrorBody>(&text).ok();
    let message = body
        .as_ref()
        .and_then(|body| body.error.clone())
        .unwrap_or_else(|| {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                status.canonical_reason().unwrap_or("HTTP error").to_owned()
            } else {
                trimmed.to_owned()
            }
        });
    Err(ApiError::Http {
        status,
        code: body.and_then(|body| body.code),
        message,
    })
}

/// Reads SSE `data:` blocks, ignoring comments and malformed event JSON.
pub struct EventStream {
    response: reqwest::Response,
    pending: Vec<u8>,
    data: Vec<u8>,
}

impl EventStream {
    pub async fn next_event(&mut self) -> Result<Option<Event>, ApiError> {
        loop {
            while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
                let mut line: Vec<_> = self.pending.drain(..=end).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if line.is_empty() {
                    if self.data.is_empty() {
                        continue;
                    }
                    if self.data.last() == Some(&b'\n') {
                        self.data.pop();
                    }
                    if let Ok(event) = serde_json::from_slice::<Event>(&self.data) {
                        self.data.clear();
                        return Ok(Some(event));
                    }
                    self.data.clear();
                } else if let Some(value) = line.strip_prefix(b"data:") {
                    let value = value.strip_prefix(b" ").unwrap_or(value);
                    self.data.extend_from_slice(value);
                    self.data.push(b'\n');
                }
            }
            match time::timeout(STREAM_SILENCE, self.response.chunk()).await {
                Ok(Ok(Some(chunk))) => self.pending.extend_from_slice(&chunk),
                Ok(Ok(None)) => return Ok(None),
                Ok(Err(error)) => return Err(ApiError::Transport(error)),
                Err(_) => return Err(ApiError::StreamSilence),
            }
        }
    }
}
