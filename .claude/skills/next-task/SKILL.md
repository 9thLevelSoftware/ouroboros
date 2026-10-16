---
name: next-task
description: Pick up the next Ouroboros work item from docs/status/progress.md and carry it through implementation, independent review and a PR. Use when asked to continue development, work the next task, or fix a review finding.
---

1. Read `docs/status/progress.md` and take the first unfinished item under "Next work, in order", unless the user named one. Respect the gate B decision recorded there: don't start Tasks 9+ while it is open. Confirm the item can be done in this environment using the "Where each check can run" table. If it needs Windows, WSL or a live provider, stop and tell the user what they need to run.
2. Scope it to one PR-sized change: one finding ID (or a tight group in one module), or one plan task step. State the scope in a sentence before starting.
3. Dispatch the `sol-engineer` subagent with the scope, the finding text or plan task section, and the file list. Wait for its receipt.
4. Dispatch the `sol-reviewer` subagent on the resulting diff. If it requests changes, send the blocking findings back to `sol-engineer` (same two-attempt limit), then review once more. Unresolved blocking findings go to the user, not into the PR.
5. Update `docs/status/progress.md`:
   - mark the item done, or record what is left;
   - add any newly stale receipts;
   - move or remove finding IDs in `docs/status/review-*.md` once fixed.
6. Commit with a message naming the finding or task, push to the session branch, and open (or update) the PR. The PR body lists:
   - the receipt;
   - the reviewer verdict;
   - which checks only Windows CI can confirm.

The item is done when the PR is open, the reviewer approved, and `progress.md` reflects the new state.
