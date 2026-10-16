---
name: steward
description: Repository conventions for driving an Ouroboros PR to green, covering CI evidence, Windows-only failures and reruns. Read before acting on CI or review events for this repo.
---

**Evidence classes.** Hosted CI is its own evidence class. A green CI run is not a task receipt, a qualification or a live acceptance, so never tick plan checkboxes or change `progress.md` qualification states because CI passed.

**Reproducing a red job.**
- **Linux job:** reproduce in the session (`npm run typecheck`, `npm run test:portable`, the bridge `tsc`, `cargo build`), fix, then rerun only the failing check locally before pushing.
- **Windows job:** a cloud session can't reproduce it. Read the job log, fix from the evidence, and say in the PR which Windows check the push is meant to turn green. If the failure needs the user's machine to diagnose (Job Object behaviour, codex.exe, PowerShell 7), comment once with the failing test and log excerpt, and tell the user.
- **Windows-only tests in a portable run:** they don't belong in `test:portable`. Fix the exclusion list in `vitest.portable.config.ts`, never the test.

**Reruns.** Inside a session, rerun only failed or affected checks; CI covers the full suite on each push. One CI re-run is allowed only for a job that died before tests started (checkout, install, runner loss).

**Merge conflicts.** Merge `main` into the branch; never rebase a pushed branch. Regenerate `package-lock.json` with `npm install --package-lock-only` under the pinned Node, never by hand.

**Review findings.** Treat findings from `sol-reviewer` or a review bot about fail-closed boundaries, evidence honesty or crash paths as blocking: fix them or explain in the thread why the path is not real.
