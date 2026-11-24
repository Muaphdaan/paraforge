# ParaForge repo notes

- Owner and approver: Jinx. Approved decisions live in the project brief; do not change them without Jinx's OK.
- No visual styling in `src/` until the design spec is approved; then build UI from design tokens, never from sliced mockups.
- Keep Bungie tokens and app secrets in the Rust side and Windows Credential Manager only. Never log them, never send them to the interface, never commit them.
- Keep `paraforge-core` free of UI and network code so it tests on Linux CI.
- Before pushing: `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test -p paraforge-core`, `pnpm typecheck`.
