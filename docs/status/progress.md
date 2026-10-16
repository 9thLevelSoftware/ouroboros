# Progress

The tracked status of the implementation plan. The raw execution ledger (`.superpowers/sdd/…`: receipts, design notes, prepared manifests) stays local on the Windows machine and is gitignored. Update this file in the same PR as the work it describes.

Last updated: 2026-10-16.

## Where things stand

| Task | State |
| --- | --- |
| 1–6 | Done per the plan checkboxes. The 2026-10-16 review found defects in this code; see [the review](review-2026-10-16.md). |
| 7 | Stage 1 done: ledger, preflight and a two-probe verifier slice. Live probes (Q2) are not built. **Native Codex is UNQUALIFIED.** |
| 8 | Not started. It needs the ledger generalised first (Q1). |
| 9–18 | Not started. Gate B blocks them (see the open decision below). |

## Next work, in order

1. **Live-path blockers:** P1–P5. Each is a small, testable change in the provider adapters.
2. **Store foundations:** S1 reconcile/takeover, S2 byte-exact artifact path, S3 run transitions, check/knowledge APIs and a migration runner.
3. **Supervisor evidence:** R1 exit status, R3/R4 stop-reason separation, R5 crash-surviving evidence.
4. **Qualification:** Q1 generalise the ledger, then Task 8's offline part (`tests/claude-qualification.test.ts`). Then Task 7's remaining live probes.
5. **Live qualification** (user, on Windows/WSL): Task 7 run, then Task 8 run.
6. **Tasks 9–18** in plan order.

## Open decision: gate B versus offline progress

The plan stops dependent work (Tasks 9+) until both live qualification receipts exist, and those receipts can only be produced on the user's machine. Tasks 9–16 are mostly deterministic code with fake providers, so they could be built in cloud sessions while qualification proceeds. Their **use** would stay gated on the receipts. Until the user decides, cloud sessions stay on items 1–4 above.

## Where each check can run

| Check | Cloud session (Linux) | Windows CI | User's Windows/WSL machine |
| --- | --- | --- | --- |
| `npm run typecheck`, `npm run build` | yes | yes | yes |
| `npm run test:portable` (14 files) | yes | (subset of `npm test`) | yes |
| `npm test` (all 20 files) | no: 6 files are Windows-only and litter the repo on Linux | yes | yes |
| Bridge compile (`adapters/claude`, `tsc --noEmit`) | yes | Linux job | in WSL |
| `cargo build` supervisor | yes (Linux backend) | yes (Windows backend) | yes |
| `cargo test --test windows_ownership` | no | yes | yes |
| `cargo test --test linux_ownership` | no (needs a systemd user manager) | no | WSL only, with explicit authorization |
| Live qualification / acceptance | never | never | yes, explicitly run by the user |

## Stale receipts

Moving the Claude options projection (B1) changed imports in `src/providers/claude/` and `adapters/claude/src/`. The affected checks were rerun and pass (root typecheck, adapter `tsc`, `claude-options`, `claude-adapter`, `claude-stop-regressions`).

All `src/**` hashes changed, so any local qualification target hash computed before this commit no longer matches. That is harmless while everything is UNQUALIFIED.
