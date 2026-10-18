# Shipyard GPUI shell

This native shell is an isolated fixture for the Rust and GPUI migration. It does not connect to a box or read the existing Shipyard configuration and data directories.

On macOS, run `cargo run --manifest-path rust/crates/shipyard-app/Cargo.toml -- --fixture`. Use `--light` to start with the light palette. The sidebar changes the visible empty state, and the appearance button switches palettes.

This slice establishes the window, navigation, layout, and theme primitives. It does not yet implement the current app's worktree, terminal, browser, agent, or settings behavior.
