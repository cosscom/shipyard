use shipyard_api::{ApiError, Client};
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
            while !raw.ends_with(b"\r\n\r\n") {
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
