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

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskTemplate {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "box")]
    pub box_name: Option<String>,
    pub location: Option<String>,
    pub agent: Option<String>,
    pub command: Option<String>,
    pub prompt: Option<String>,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub variables: Option<Vec<TemplateVariable>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TemplateVariable {
    pub id: String,
    pub label: Option<String>,
    pub multiline: Option<bool>,
    pub default: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Theme {
    pub id: String,
    pub name: String,
    pub appearance: ThemeAppearance,
    pub colors: ThemeColors,
    pub terminal: TerminalColors,
    pub syntax: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeAppearance {
    Dark,
    Light,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    pub background: String,
    pub foreground: String,
    pub sidebar: String,
    pub sidebar_foreground: String,
    pub muted: String,
    pub muted_foreground: String,
    pub border: String,
    pub accent: String,
    pub accent_foreground: String,
    pub primary: String,
    pub primary_foreground: String,
    pub card: String,
    pub popover: String,
    pub ring: String,
    pub success: String,
    pub warning: String,
    pub destructive: String,
    pub info: Option<String>,
    pub success_foreground: Option<String>,
    pub warning_foreground: Option<String>,
    pub destructive_foreground: Option<String>,
    pub info_foreground: Option<String>,
    pub link: Option<String>,
    pub selection: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalColors {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub selection_background: String,
    pub selection_foreground: Option<String>,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}
