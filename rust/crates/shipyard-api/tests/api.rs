use serde::{Deserialize, Serialize};
use shipyard_api::{ApiError, Client, ThemeAppearance};
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::watch,
    time::{timeout, Duration},
};

async fn mock_server(responses: Vec<Vec<String>>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    tokio::spawn(async move {
        for chunks in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut bytes = [0; 1024];
            let header_end = loop {
                if let Some(end) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
                    break end + 4;
                }
                let count = socket.read(&mut bytes).await.unwrap();
                if count == 0 {
                    break raw.len();
                }
                raw.extend_from_slice(&bytes[..count]);
            };
            let headers = String::from_utf8_lossy(&raw[..header_end]).to_ascii_lowercase();
            let body_len = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|length| length.trim().parse::<usize>().ok())
                .unwrap_or(0);
            while raw.len() < header_end + body_len {
                let count = socket.read(&mut bytes).await.unwrap();
                if count == 0 {
                    break;
                }
                raw.extend_from_slice(&bytes[..count]);
            }
            seen.lock()
                .unwrap()
                .push(String::from_utf8(raw).unwrap().to_ascii_lowercase());
            for chunk in chunks {
                socket.write_all(chunk.as_bytes()).await.unwrap();
                tokio::task::yield_now().await;
            }
        }
    });
    (address, requests)
}

fn json_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
struct SettingsDocument {
    default_box: String,
}

#[tokio::test]
async fn app_documents_preserve_missing_null_and_echo_typed_puts() {
    let body = r#"{"default_box":"acme"}"#;
    let (address, requests) = mock_server(vec![
        vec![json_response("200 OK", "null")],
        vec![json_response("200 OK", body)],
        vec![json_response("200 OK", body)],
    ])
    .await;
    let client = Client::new(&address, "a-secret").unwrap();
    assert_eq!(
        client
            .app_document::<SettingsDocument>("projects")
            .await
            .unwrap(),
        None
    );
    let document = SettingsDocument {
        default_box: "acme".to_owned(),
    };
    assert_eq!(
        client
            .put_app_document("projects", &document)
            .await
            .unwrap(),
        document
    );
    assert_eq!(
        client
            .app_document::<SettingsDocument>("projects")
            .await
            .unwrap(),
        Some(document)
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[0].starts_with("get /v1/app/projects http/1.1\r\n"));
    assert!(requests[1].starts_with("put /v1/app/projects http/1.1\r\n"));
    assert!(requests[1].contains("content-type: application/json\r\n"));
    assert!(requests[1].ends_with(body));
    assert!(requests
        .iter()
        .all(|request| request.contains("authorization: bearer a-secret\r\n")));
    assert!(requests.iter().all(|request| !request.contains("?token=")));
}

#[tokio::test]
async fn app_document_put_can_store_json_null() {
    let (address, requests) = mock_server(vec![vec![json_response("200 OK", "null")]]).await;
    let client = Client::new(&address, "a-secret").unwrap();
    let empty: Option<SettingsDocument> = None;
    assert_eq!(
        client
            .put_app_document("skills-notice", &empty)
            .await
            .unwrap(),
        None
    );
    let requests = requests.lock().unwrap();
    assert!(requests[0].starts_with("put /v1/app/skills-notice http/1.1\r\n"));
    assert!(requests[0].ends_with("\r\n\r\nnull"));
}

#[tokio::test]
async fn app_document_rejects_invalid_keys_and_oversize_bodies_before_network() {
    let client = Client::new("http://127.0.0.1:9", "a-secret").unwrap();
    let document = SettingsDocument {
        default_box: "acme".to_owned(),
    };
    for key in [
        "",
        "-first",
        "Bad_Key",
        "../escape",
        "skills%2fnotice",
        "é",
        &"a".repeat(49),
    ] {
        assert!(matches!(
            client.app_document::<SettingsDocument>(key).await,
            Err(ApiError::InvalidDocumentKey)
        ));
        assert!(matches!(
            client.put_app_document(key, &document).await,
            Err(ApiError::InvalidDocumentKey)
        ));
    }
    let large = "x".repeat(1 << 20);
    assert!(matches!(
        client.put_app_document("projects", &large).await,
        Err(ApiError::DocumentTooLarge)
    ));
}

#[tokio::test]
async fn app_document_put_preserves_agent_error_response() {
    let body = r#"{"error":"the body must be JSON, at most 1 MB"}"#;
    let (address, requests) = mock_server(vec![vec![json_response("400 Bad Request", body)]]).await;
    let client = Client::new(&address, "a-secret").unwrap();
    let error = client
        .put_app_document("projects", &Some(1))
        .await
        .unwrap_err();
    match error {
        ApiError::Http {
            status,
            code,
            message,
        } => {
            assert_eq!(status.as_u16(), 400);
            assert_eq!(code, None);
            assert_eq!(message, "the body must be JSON, at most 1 MB");
        }
        other => panic!("unexpected error: {other}"),
    }
    assert!(requests.lock().unwrap()[0].contains("authorization: bearer a-secret\r\n"));
}

#[tokio::test]
async fn status_uses_bearer_header_and_decodes_agent_shape() {
    let body = r#"{"boxes":[{"name":"acme","address":"127.0.0.1:9999","fingerprint":"abc","state":"offline","since":"2026-01-01T00:00:00Z","retry_at":"2026-01-01T00:00:05Z","attempts":2,"link":{"slow":true,"path":{"via":"relay","relay":"nyc"}}}],"forwards":[],"routes":[],"proxy":{"port":1377,"url_port":80}}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let (address, requests) = mock_server(vec![vec![response]]).await;
    let status = Client::new(&address, "a-secret")
        .unwrap()
        .status()
        .await
        .unwrap();
    assert_eq!(status.boxes[0].name, "acme");
    assert_eq!(status.boxes[0].attempts, Some(2));
    assert_eq!(
        status.boxes[0]
            .link
            .as_ref()
            .unwrap()
            .path
            .as_ref()
            .unwrap()
            .via,
        "relay"
    );
    assert_eq!(status.proxy.url_port, 80);
    let requests = requests.lock().unwrap();
    assert!(requests[0].starts_with("get /v1/status http/1.1\r\n"));
    assert!(requests[0].contains("authorization: bearer a-secret\r\n"));
    assert!(!requests[0].contains("?token="));
}

#[tokio::test]
async fn coded_http_error_keeps_status_and_code() {
    let body = r#"{"error":"missing or wrong token","code":"unauthorized"}"#;
    let response = format!(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let (address, _) = mock_server(vec![vec![response]]).await;
    let error = Client::new(&address, "a-secret")
        .unwrap()
        .status()
        .await
        .unwrap_err();
    match error {
        ApiError::Http {
            status,
            code,
            message,
        } => {
            assert_eq!(status.as_u16(), 401);
            assert_eq!(code.as_deref(), Some("unauthorized"));
            assert_eq!(message, "missing or wrong token");
        }
        other => panic!("unexpected error: {other}"),
    }
}

#[tokio::test]
async fn themes_read_authenticated_typed_colors() {
    let body = r##"[{
      "id":"acme-night","name":"Acme Night","appearance":"dark","syntax":"dracula",
      "colors":{
        "background":"#111","foreground":"#eee","sidebar":"#222","sidebarForeground":"#ddd",
        "muted":"#333","mutedForeground":"#ccc","border":"#444","accent":"#555",
        "accentForeground":"#bbb","primary":"#666","primaryForeground":"#aaa",
        "card":"#777","popover":"#888","ring":"#999","success":"#090",
        "warning":"#990","destructive":"#900","link":"#00f"
      },
      "terminal":{
        "background":"#111","foreground":"#eee","cursor":"#fff","selectionBackground":"#555",
        "black":"#000","red":"#f00","green":"#0f0","yellow":"#ff0","blue":"#00f",
        "magenta":"#f0f","cyan":"#0ff","white":"#fff","brightBlack":"#555",
        "brightRed":"#f55","brightGreen":"#5f5","brightYellow":"#ff5","brightBlue":"#55f",
        "brightMagenta":"#f5f","brightCyan":"#5ff","brightWhite":"#fff"
      }
    }]"##;
    let (address, requests) = mock_server(vec![vec![json_response("200 OK", body)]]).await;
    let themes = Client::new(&address, "a-secret")
        .unwrap()
        .themes()
        .await
        .unwrap();
    assert_eq!(themes.len(), 1);
    assert_eq!(themes[0].id, "acme-night");
    assert_eq!(themes[0].appearance, ThemeAppearance::Dark);
    assert_eq!(themes[0].colors.sidebar_foreground, "#ddd");
    assert_eq!(themes[0].colors.link.as_deref(), Some("#00f"));
    assert_eq!(themes[0].terminal.bright_cyan, "#5ff");
    assert_eq!(themes[0].terminal.selection_foreground, None);
    let requests = requests.lock().unwrap();
    assert!(requests[0].starts_with("get /v1/themes http/1.1\r\n"));
    assert!(requests[0].contains("authorization: bearer a-secret\r\n"));
    assert!(!requests[0].contains("?token="));
}

#[tokio::test]
async fn templates_read_authenticated_optional_fields() {
    let body = r#"[{"id":"acme-review","name":"Review","box":"acme","prompt":"Review {{scope}}","variables":[{"id":"scope","label":"Scope","multiline":true,"default":"all"}]},{"id":"acme-simple","name":"Simple"}]"#;
    let (address, requests) = mock_server(vec![vec![json_response("200 OK", body)]]).await;
    let templates = Client::new(&address, "a-secret")
        .unwrap()
        .templates()
        .await
        .unwrap();
    assert_eq!(templates.len(), 2);
    assert_eq!(templates[0].box_name.as_deref(), Some("acme"));
    assert_eq!(
        templates[0].variables.as_ref().unwrap()[0].multiline,
        Some(true)
    );
    assert_eq!(templates[1].description, None);
    assert_eq!(templates[1].variables, None);
    let requests = requests.lock().unwrap();
    assert!(requests[0].starts_with("get /v1/templates http/1.1\r\n"));
    assert!(requests[0].contains("authorization: bearer a-secret\r\n"));
}

#[tokio::test]
async fn list_endpoints_preserve_http_errors_and_reject_invalid_json() {
    let error_body = r#"{"error":"missing or wrong token","code":"unauthorized"}"#;
    let (address, _) = mock_server(vec![
        vec![json_response("401 Unauthorized", error_body)],
        vec![json_response("200 OK", r#"[{"id":"acme"}]"#)],
    ])
    .await;
    let client = Client::new(&address, "a-secret").unwrap();
    match client.themes().await.unwrap_err() {
        ApiError::Http { status, code, .. } => {
            assert_eq!(status.as_u16(), 401);
            assert_eq!(code.as_deref(), Some("unauthorized"));
        }
        other => panic!("unexpected error: {other}"),
    }
    assert!(matches!(client.templates().await, Err(ApiError::Decode(_))));
}

#[tokio::test]
async fn events_parse_split_sse_blocks_and_skip_bad_data() {
    let (address, requests) = mock_server(vec![vec![
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n: berth\r\n\r\ndata: {\"type\":\"box.".to_owned(),
        "online\",\"time\":\"2026-01-01T00:00:00Z\",\"box\":\"acme\"}\r\n\r\n".to_owned(),
        "data: invalid\r\n\r\n: keepalive\r\n\r\n".to_owned(),
    ]])
    .await;
    let mut stream = Client::new(&address, "a-secret")
        .unwrap()
        .events()
        .await
        .unwrap();
    let event = stream.next_event().await.unwrap().unwrap();
    assert_eq!(event.kind, "box.online");
    assert_eq!(event.box_name.as_deref(), Some("acme"));
    assert!(stream.next_event().await.unwrap().is_none());
    let requests = requests.lock().unwrap();
    assert!(requests[0].contains("accept: text/event-stream\r\n"));
    assert!(requests[0].contains("authorization: bearer a-secret\r\n"));
}

#[tokio::test]
async fn follower_reconnects_and_calls_on_connect_each_time() {
    let reply = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"type\":\"box.online\",\"time\":\"2026-01-01T00:00:00Z\"}\n\n";
    let (address, requests) =
        mock_server(vec![vec![reply.to_owned()], vec![reply.to_owned()]]).await;
    let client = Client::new(&address, "a-secret").unwrap();
    let (stop_tx, stop_rx) = watch::channel(false);
    let connects = Arc::new(Mutex::new(0));
    let events = Arc::new(Mutex::new(0));
    let connect_count = connects.clone();
    let event_count = events.clone();
    timeout(
        Duration::from_secs(3),
        client.follow_events(
            stop_rx,
            move || *connect_count.lock().unwrap() += 1,
            move |_| {
                let mut count = event_count.lock().unwrap();
                *count += 1;
                if *count == 2 {
                    stop_tx.send(true).unwrap();
                }
            },
        ),
    )
    .await
    .unwrap();
    assert_eq!(*connects.lock().unwrap(), 2);
    assert_eq!(*events.lock().unwrap(), 2);
    assert_eq!(requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn follower_ignores_false_stop_updates() {
    let reply = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"type\":\"box.online\",\"time\":\"2026-01-01T00:00:00Z\"}\n\n";
    let (address, requests) =
        mock_server(vec![vec![reply.to_owned()], vec![reply.to_owned()]]).await;
    let client = Client::new(&address, "a-secret").unwrap();
    let (stop_tx, stop_rx) = watch::channel(false);
    let events = Arc::new(Mutex::new(0));
    let count = events.clone();
    timeout(
        Duration::from_secs(3),
        client.follow_events(
            stop_rx,
            || {},
            move |_| {
                let mut seen = count.lock().unwrap();
                *seen += 1;
                if *seen == 1 {
                    stop_tx.send(false).unwrap();
                } else {
                    stop_tx.send(true).unwrap();
                }
            },
        ),
    )
    .await
    .unwrap();
    assert_eq!(*events.lock().unwrap(), 2);
    assert_eq!(requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn follower_stops_when_owner_drops_stop_sender() {
    let (address, _) = mock_server(Vec::new()).await;
    let client = Client::new(&address, "a-secret").unwrap();
    let (stop_tx, stop_rx) = watch::channel(false);
    drop(stop_tx);
    timeout(
        Duration::from_secs(1),
        client.follow_events(stop_rx, || {}, |_| {}),
    )
    .await
    .unwrap();
}

#[test]
fn endpoint_rejects_credentials_and_query_token() {
    assert!(matches!(
        Client::new("http://user:pass@localhost:1378", "secret"),
        Err(ApiError::InvalidEndpoint)
    ));
    assert!(matches!(
        Client::new("http://localhost:1378?token=secret", "secret"),
        Err(ApiError::InvalidEndpoint)
    ));
    assert!(matches!(
        Client::new("https://example.com:1378", "secret"),
        Err(ApiError::InvalidEndpoint)
    ));
    assert!(matches!(
        Client::new("http://localhost:1378", "bad\nheader"),
        Err(ApiError::InvalidToken)
    ));
}
