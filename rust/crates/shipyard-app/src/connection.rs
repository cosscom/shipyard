use shipyard_api::{ApiError, Client, Status};

pub(crate) struct LaunchOptions {
    pub appearance_light: bool,
    pub fixture: bool,
    pub endpoint: Option<String>,
}

pub(crate) enum ParsedArgs {
    Help,
    Launch(LaunchOptions),
}

pub(crate) enum LaunchMode {
    Fixture,
    Live(Client),
}

pub(crate) enum ConnectionState {
    Fixture,
    Idle,
    Loading,
    Connected(Vec<BoxSummary>),
    Error(ConnectionIssue),
}

pub(crate) struct BoxSummary {
    pub name: String,
    pub state: String,
}

pub(crate) enum ConnectionIssue {
    Unauthorized,
    Network,
    InvalidResponse,
    Http(u16),
    Runtime,
}

impl ConnectionIssue {
    pub fn message(&self) -> &'static str {
        match self {
            Self::Unauthorized => "Authentication failed. Check SHIPYARD_API_TOKEN.",
            Self::Network => "Cannot reach the laptop agent. Check the endpoint and agent process.",
            Self::InvalidResponse => "The laptop agent returned an invalid status response.",
            Self::Http(_) => "The laptop agent rejected the status request.",
            Self::Runtime => "The status worker could not start.",
        }
    }

    pub fn title(&self) -> String {
        match self {
            Self::Http(status) => format!("Connection error · HTTP {status}"),
            _ => "Connection error".to_owned(),
        }
    }
}

impl From<ApiError> for ConnectionIssue {
    fn from(error: ApiError) -> Self {
        match error {
            ApiError::Http { status, .. } if status.as_u16() == 401 || status.as_u16() == 403 => {
                Self::Unauthorized
            }
            ApiError::Http { status, .. } => Self::Http(status.as_u16()),
            ApiError::Decode(_) => Self::InvalidResponse,
            ApiError::Transport(_) | ApiError::StreamSilence => Self::Network,
            ApiError::InvalidEndpoint | ApiError::InvalidToken => Self::Runtime,
        }
    }
}

impl From<Status> for ConnectionState {
    fn from(status: Status) -> Self {
        Self::Connected(
            status
                .boxes
                .into_iter()
                .map(|box_status| BoxSummary {
                    name: box_status.name,
                    state: box_status.state,
                })
                .collect(),
        )
    }
}

pub(crate) fn parse_args(
    args: impl IntoIterator<Item = String>,
) -> Result<ParsedArgs, &'static str> {
    let mut options = LaunchOptions {
        appearance_light: false,
        fixture: false,
        endpoint: None,
    };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--fixture" => options.fixture = true,
            "--light" => options.appearance_light = true,
            "--endpoint" => {
                let endpoint = args.next().ok_or("Missing value for --endpoint")?;
                if options.endpoint.replace(endpoint).is_some() {
                    return Err("--endpoint may only be set once");
                }
            }
            "--help" | "-h" => return Ok(ParsedArgs::Help),
            _ => return Err("Unknown argument. Use --help for usage."),
        }
    }
    if options.fixture && options.endpoint.is_some() {
        return Err("--fixture and --endpoint cannot be combined");
    }
    Ok(ParsedArgs::Launch(options))
}

pub(crate) fn choose_mode(
    options: &LaunchOptions,
    token: Option<&str>,
) -> Result<LaunchMode, &'static str> {
    let Some(endpoint) = options.endpoint.as_deref() else {
        return Ok(LaunchMode::Fixture);
    };
    let token = token
        .filter(|token| !token.is_empty())
        .ok_or("SHIPYARD_API_TOKEN is required with --endpoint")?;
    Client::new(endpoint, token)
        .map(LaunchMode::Live)
        .map_err(|_| "Invalid endpoint or token. Use a loopback HTTP endpoint and a valid token.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_mode_stays_offline_even_when_token_exists() {
        let ParsedArgs::Launch(options) = parse_args(["--fixture".to_owned()]).unwrap() else {
            panic!("expected launch options");
        };
        assert!(matches!(
            choose_mode(&options, Some("secret")).unwrap(),
            LaunchMode::Fixture
        ));
    }

    #[test]
    fn live_mode_requires_explicit_loopback_endpoint_and_token() {
        let ParsedArgs::Launch(options) =
            parse_args(["--endpoint".to_owned(), "http://127.0.0.1:1427".to_owned()]).unwrap()
        else {
            panic!("expected launch options");
        };
        assert!(choose_mode(&options, None).is_err());
        assert!(matches!(
            choose_mode(&options, Some("secret")).unwrap(),
            LaunchMode::Live(_)
        ));

        let ParsedArgs::Launch(remote) =
            parse_args(["--endpoint".to_owned(), "https://example.com".to_owned()]).unwrap()
        else {
            panic!("expected launch options");
        };
        assert!(choose_mode(&remote, Some("secret")).is_err());
    }

    #[test]
    fn conflicting_modes_and_unrecognized_arguments_fail_without_echoing_input() {
        assert!(
            parse_args([
                "--fixture".to_owned(),
                "--endpoint".to_owned(),
                "http://127.0.0.1:1427".to_owned(),
            ])
            .is_err()
        );
        assert_eq!(
            parse_args(["--token=secret".to_owned()]).err(),
            Some("Unknown argument. Use --help for usage.")
        );
    }

    #[test]
    fn server_error_text_cannot_reach_the_window() {
        let issue = ConnectionIssue::from(ApiError::Http {
            status: reqwest::StatusCode::BAD_GATEWAY,
            code: Some("secret-code".to_owned()),
            message: "secret-message".to_owned(),
        });
        assert_eq!(issue.title(), "Connection error · HTTP 502");
        assert_eq!(
            issue.message(),
            "The laptop agent rejected the status request."
        );
    }
}
