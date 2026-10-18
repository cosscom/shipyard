# Shipyard GPUI shell

This native shell is an isolated starting point for the Rust and GPUI migration. It never reads the existing Shipyard configuration and data directories.

On macOS, run `cargo run --manifest-path rust/crates/shipyard-app/Cargo.toml -- --fixture` for an offline fixture. With no arguments, the shell also starts offline. Use `--light` to start with the light palette. The sidebar changes the visible page, and the appearance button switches palettes.

For a live status read, set `SHIPYARD_API_TOKEN` in the launching process's environment and run `cargo run --manifest-path rust/crates/shipyard-app/Cargo.toml -- --endpoint http://127.0.0.1:PORT`. The endpoint must be loopback. The shell sends the token in an authorization header and shows box names and states from `/v1/status`. Refresh repeats the read. Connection errors shown in the window omit server response text and credentials.

This slice establishes the window, navigation, layout, theme primitives, and an authenticated status read. It does not yet implement the current app's worktree, terminal, browser, agent, or settings behavior.
