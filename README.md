# ParaForge

A personal Destiny 2 weapon library, god-roll analyser and progression tracker for Windows.

Work in progress. The interface is unstyled until the design system is locked.

## Layout

| Path | What it is |
| --- | --- |
| `crates/paraforge-core` | Data model, local SQLite database and scoring engine. No UI, no network; builds and tests on any OS. |
| `src-tauri` | The Tauri 2 desktop shell. Exposes a short allow-list of commands to the interface. |
| `src` | The React + TypeScript interface. |

## Develop

Needs Rust (stable), Node 22 and pnpm 10.

```sh
pnpm install
pnpm tauri dev                  # run the app
cargo test -p paraforge-core    # core tests
```

New npm package versions are only installed once they are 7 days old (`pnpm-workspace.yaml`).

## Scoring

`paraforge-core` rates each owned copy for a context (PvE or PvP) from perk ratings, the best
matching curated roll, tier, masterwork and enhanced perks, then compares copies of the same
weapon to give a verdict: KEEP, UPGRADE, REPLACE or SHARD. The values in `ScoringRules::default()`
are development placeholders; real values will ship in the signed data pack.
`crates/paraforge-core/tests/sample_vault.rs` pins the expected verdicts for a sample vault.
