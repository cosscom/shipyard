use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Status {
    pub boxes: Vec<BoxStatus>,
    pub forwards: Vec<ForwardStatus>,
    pub routes: Vec<Route>,
    pub proxy: ProxyStatus,
    pub team_suggestions: Option<Vec<TeamSuggestion>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct BoxStatus {
    pub name: String,
    pub address: String,
    pub fingerprint: String,
    pub state: String,
    pub since: String,
    pub network: Option<String>,
    pub error: Option<String>,
    pub latency_ms: Option<i64>,
    pub local: Option<bool>,
    pub retry_at: Option<String>,
    pub attempts: Option<u32>,
    pub link: Option<BoxLink>,
    pub route: Option<String>,
    pub routes: Option<Vec<BoxRoute>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct BoxRoute {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub state: String,
    pub detail: Option<String>,
    pub latency_ms: Option<i64>,
    pub active: Option<bool>,
    pub error: Option<String>,
    pub auto: Option<bool>,
    pub suggested: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct BoxLink {
    pub slow: Option<bool>,
    pub reason: Option<String>,
    pub max_ms: Option<i64>,
    pub jitter_ms: Option<i64>,
    pub path: Option<BoxPath>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct BoxPath {
    pub via: String,
    pub relay: Option<String>,
    pub relay_name: Option<String>,
    pub nearest: Option<String>,
    pub endpoint: Option<String>,
    pub tailnet: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ForwardStatus {
    pub id: String,
    #[serde(rename = "box")]
    pub box_name: String,
    pub local: u16,
    pub remote: u16,
    pub pin: Option<String>,
    pub state: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Route {
    pub pattern: String,
    #[serde(rename = "box")]
    pub box_name: String,
    pub port: u16,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ProxyStatus {
    pub port: u16,
    pub url_port: u16,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TeamSuggestion {
    pub org: String,
    pub name: String,
    pub repo: String,
    pub projects: Vec<TeamSuggestProject>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TeamSuggestProject {
    #[serde(rename = "box")]
    pub box_name: String,
    pub location: String,
    pub repo: String,
    pub listed: bool,
    pub sets_up: Vec<String>,
    pub kit: Option<bool>,
    pub kit_applied: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Event {
    pub seq: Option<i64>,
    #[serde(rename = "type")]
    pub kind: String,
    pub time: String,
    #[serde(rename = "box")]
    pub box_name: Option<String>,
    pub origin: Option<String>,
    pub error: Option<String>,
    pub data: Option<Map<String, Value>>,
}
