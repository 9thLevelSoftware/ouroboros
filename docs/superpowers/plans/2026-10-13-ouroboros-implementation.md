# Ouroboros Local Engineering Harness Implementation Plan

> Current continuation, 2026-10-21: [Flexible runtime and toolchain support](2026-10-21-flexible-runtime-support.md) governs current version handling and offline acceptance. Exact tool releases below are historical reference snapshots, superseded for ordinary execution by a per-run identity and startup capability contract. Qualification remains specific to its actual target. Task 7 is incomplete (five OPEN blockers, 0/32 accepted probes for the changed target); no live retry, Task 8 work, or publication is authorized by this continuation. Historical task checkboxes and evidence remain unchanged.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a scoped task in an existing repository into an independently verified local patch for human review, using the user's Codex or Claude subscription.

**Architecture:** A Windows TypeScript controller owns task contracts, isolated snapshots, verification, lifecycle, SQLite records, and reviewed knowledge. Official provider runtimes do the implementation; a small Rust helper supervises owned processes, while provider-supported sandboxes enforce command restrictions. Capability qualification precedes the autonomous repair loop.

**Tech Stack:** Node.js 24 LTS, TypeScript, Zod, better-sqlite3, Vitest, Codex app-server over stdio, Claude Agent SDK in WSL2, Rust process supervision, Windows Job Objects, systemd/cgroup v2.

**Spec:** [Approved design](../specs/2026-10-13-ouroboros-design.md)

Status: User approved subagent-driven execution. Implementation is in progress; completed checkboxes are backed by the task ledger and review evidence. Planning version observations below are from 2026-10-13.

## Global Constraints

- Provide a terminal interface launched from Windows PowerShell.
- Support either Codex or Claude through the user's subscription authentication and official runtime interfaces.
- Preserve the original checkout and work in progress.
- Establish acceptance criteria and verification commands before implementation.
- The output status is `READY_FOR_REVIEW`.
- Version 1 handles one scoped task at a time per source repository.
- Native Codex and WSL Claude are the initial required paths.
- WSL Codex fallback is enabled only after its own qualification.
- Native Claude autonomous execution remains excluded.
- The initial candidate failure establishes the repair need; it is not itself a repair attempt.
- After the second unsuccessful repair, stop in `REPAIR_LIMIT_REACHED`; resume does not reset this counter.
- Run each planned authoritative check once; after a supported repair, rerun only affected failed checks.
- A stale prior pass requires `NEEDS_REVALIDATION` and explicit narrow revalidation authorization.
- No automatic paid API fallback, provider switching, policy expansion, lesson promotion, or application to the source checkout.
- No commit, push, release publication, or service registration occurs as a side effect of running a task.
- Keep controller state, approved policy, verification plans, authoritative evidence, and approved knowledge outside worker-writable paths.
- Do not replay unknown actions automatically.

## Review Focus

1. Dirty source with staged, unstaged, untracked, binary, or CRLF content: preserve its bytes and export only changes from the captured working baseline. Tasks 9, 10, 17.
2. Windows/WSL path aliases, link escapes, case collisions, and malicious Git filters: reject unsupported inputs before dispatch and never follow an escape. Tasks 7–10.
3. Controller crash or cancellation between dispatch and acknowledgment: preserve unknown outcomes, drain owned descendants, and leave unrelated processes alive. Tasks 2–8, 14.
4. A repair changes inputs of an already-passing check or weakens test discovery: block a verified label until fresh authorized evidence and integrity review exist. Tasks 11–13.
5. Runtime updates, subscription exhaustion, or accidental API-key precedence: invalidate affected qualification and checkpoint without changing billing source. Tasks 1, 5–8, 13–14.

---

## Execution rules and milestones

This is one integrated release. Tasks 1–8 establish trustworthy execution; tasks 9–17 build the usable engineering workflow; task 18 assembles release evidence. Jev, a GUI, public distribution, and unattended task discovery are deferred.

| Gate | Deliverable | Stop condition |
| --- | --- | --- |
| A: Tasks 1–6 | Tested contracts, store, supervisors, adapter protocols | A required documented control cannot be expressed or a deterministic ownership test fails |
| B: Tasks 7–8 | Separate native Codex and WSL Claude qualification receipts | Either required path lacks its implementation **or verification** boundary; do not build dependent autonomous features |
| C: Tasks 9–14 | Preserved baseline, checks, bounded loop, recovery | Missing acceptance, stale passes, unknown actions, or incomplete drainage |
| D: Tasks 15–18 | Reviewed memory, CLI, local patches, end-to-end evidence | Any required local case is unverified; external gates remain separately labeled |

Task dependencies: `1 → 2 → 3 → 4`; `5` uses 1–3; `6` uses 1–5, including the common ProviderAdapter contract; `7` uses 4–5; `8` uses 4, 6–7. After both qualification gates, `9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18`. Module development can overlap only where dependencies and file ownership permit. Prefer one implementation worker and one independent reviewer, not several workers editing contracts simultaneously.

All commands below are **future implementation steps**, not commands already run. Work from `D:\ouroboros` unless a task explicitly names its qualified WSL environment. Preserve the approved documents. The workspace currently has no Git metadata; do not initialize or commit the product repository without authorization. Disposable Git fixture histories are test data created only within a recorded fixture root. Never use test setup commands on the user's source checkout.

For each task, write its named tests, run the named check once to establish a meaningful failure, implement, then rerun only that failed check. An import error may establish the first scaffold failure; thereafter prefer behavioral failures. Stop after two distinct unsuccessful repairs. End each task with a review checkpoint and a receipt containing changed files, command, input hash, and result. No automatic commit step is included. Reuse still-valid receipts; do not repeatedly run an aggregate suite. If a later change invalidates an earlier passing receipt, list the affected check and obtain the required narrow revalidation authorization.

### Selected versions and setup boundaries

Exact package versions were read from the npm/crates registries during planning; compatibility remains to be tested. Install exact versions and retain lockfiles during execution. A unavailable or incompatible pin is a documented plan adjustment, never a silent `latest` upgrade.

| Item | Planned pin | Use |
| --- | --- | --- |
| Node.js / npm | `24.19.0` / `11.17.0` | Observed Windows versions; same Node baseline for WSL adapter |
| TypeScript / Vitest | `7.0.2` / `5.0.4` | Compile and focused tests |
| Zod | `4.6.7` | Strict process/persistence contracts |
| better-sqlite3 / types | `13.0.3` / `@types/better-sqlite3@9.6.0` | Windows controller database |
| Node types | `@types/node@24.19.2` | Compile-time Node contracts |
| Codex CLI | `0.162.1` | Observed Windows runtime; generated protocol pinned to it |
| Claude Agent SDK | `0.3.299` | WSL-local adapter dependency; record its actual bundled CLI too |
| Anthropic sandbox-runtime | `0.0.79` | Independently qualified WSL verifier command wrapper |
| Rust | `1.98.1` | Observed Windows toolchain; matching WSL helper build |
| Rust crates | `windows-sys=0.61.2`, `serde=1.0.229`, `serde_json=1.0.154` | Exact dependency requirements and Cargo.lock |
| Linux systemd binding | `zbus=5.19.0` | Linux-only blocking manager API; added after the recorded Task4 capability probe |

Keep WSL-only packages in `adapters/claude/`, with their own lockfile; do not copy Windows `node_modules` into WSL. System packages (`systemd`, `bubblewrap`, `socat`) and the kernel are host prerequisites: record their actual versions in qualification rather than pretending npm pins them. Do not install a distribution, alter WSL configuration, enable system services, or change provider login implicitly. `doctor` reports concrete missing prerequisites; active setup is a separate explicit action.

### Operational defaults

These are Ouroboros product choices, not claimed provider limits. Persist overrides before dispatch.

| Limit | Default |
| --- | --- |
| Cumulative active run time | 30 minutes; includes implementation, verification, and drainage; excludes a durable idle checkpoint |
| Per verification command | 5 minutes, bounded by remaining run time |
| Repair bound | 2 unsuccessful corrective candidates after the initial failure |
| Provider/bridge control frame | 1 MiB; reject oversize before allocation |
| Durable output per action / per run | 10 MiB / 100 MiB; count before redaction; stop producers at exhaustion and retain a stop receipt |
| Model diagnostic excerpt | 16 KiB combined head/tail with offsets and truncation marker |
| Approved lesson context | 32 KiB, deterministic relevance order |
| Supervisor lease renewal / expiry | 2 seconds / 10 seconds; monotonic clock |
| Graceful drain / evidence window | 5 seconds / up to 15 further seconds; otherwise remain `DRAINING` |
| Heartbeat stability proof | No growth for 2 seconds, plus owned process/unit emptiness and runtime inventory where available |

Counts and dates are computed in code. Provider token, request, and money totals are nullable observations, never inferred hard limits. Snapshot/patch storage has a separate declared `maxSnapshotBytes` default of 1 GiB; exceeding it is preflight failure, not silent file exclusion. Live qualification uses 10-minute per-case limits and explicitly reports consumption where observable.

## File and contract map

The exact files are assigned below. No shared `utils.ts` dumping ground or plugin framework is needed.

| Location | Responsibility |
| --- | --- |
| `src/contracts/` | Schemas and shared records; no provider-specific API types |
| `src/cli/` | Argument parsing, passive diagnostics, command dispatch, human-readable views |
| `src/store/` | SQLite migrations, ownership fencing, artifacts, action journal |
| `src/runtime/` | Supervision client and environment-specific command boundaries |
| `native/supervisor/` | Small Rust process owner, Windows job and WSL unit integration |
| `src/providers/codex/` | Generated pinned protocol, transport, approvals, adapter |
| `adapters/claude/` | WSL-local SDK bridge and sandbox configuration |
| `src/qualification/` | Versioned capability ledger and explicit probes |
| `src/workspace/` | Source inspection, manifests, independent checkout, candidate export |
| `src/task/`, `src/verification/`, `src/controller/` | Task preparation, authoritative checks, lifecycle and recovery |
| `src/memory/` | Evidence-linked proposals, reviewed versions, retrieval |
| `tests/` | Disposable fixtures, focused unit/integration tests, opt-in live tests |
| `docs/operations/` | Setup, usage, qualification reports, limitations |

Trusted Windows data root: `%LOCALAPPDATA%\Ouroboros\controller`. Worker checkouts are separate siblings under `%LOCALAPPDATA%\Ouroboros\workspaces`; the command boundary denies the controller root and source checkout. Trusted WSL adapter/unit files live under `$XDG_DATA_HOME/ouroboros/controller` (fallback `~/.local/share/ouroboros/controller`); WSL workspaces are Linux-native siblings. Neither location is claimed isolated merely because it is outside the checkout: Tasks 7–8 must prove denied access through every enabled worker surface. No secrets or authoritative state are placed in a repository `.agent/` directory.

Shared records are strict Zod objects, exported types inferred from schemas. IDs are opaque UUIDs; hashes are lowercase SHA-256 hex; all durable records carry `schemaVersion: 1`. `Result<T>` is `{ok:true,value:T} | {ok:false,error:{code:string,message:string,evidenceIds:string[]}}`. Expected boundary failures return it; programmer defects remain exceptions captured by the controller.

## Task 1: A passive doctor command and validated contracts

**Owner:** implementation_worker. **Files:** Create `package.json`, `package-lock.json`, `.npmrc`, `.node-version`, `.gitignore`, `tsconfig.json`, `vitest.config.ts`, `src/contracts/common.ts`, `src/contracts/task.ts`, `src/contracts/run.ts`, `src/contracts/provider.ts`, `src/cli/main.ts`, `src/cli/doctor.ts`, `tests/support/contracts.ts`; test `tests/contracts.test.ts`, `tests/doctor.test.ts`.

**Interfaces:** Produces `parseTask(value: unknown): Result<TaskContract>`, `collectDoctor(deps: DoctorDependencies): Promise<DoctorReport>`, and `main(argv: string[], deps: CliDependencies): Promise<number>`. `DoctorDependencies` provides read-only command/version inspection and cached qualification lookup; it has no model-call, install, or auth-mutation function. `CliDependencies` initially contains only doctor and output streams; later tasks extend it explicitly.

- [x] Create the package with `type: module`, `private: true`, `bin` pointing to `dist/cli/main.js`; scripts `build: tsc -p tsconfig.json`, `typecheck: tsc -p tsconfig.json --noEmit`, `test: vitest run`, and `dev: node --experimental-strip-types src/cli/main.ts`. Use erasable TS syntax and relative `.ts` imports with `rewriteRelativeImportExtensions`; compile only source, test transforms handled by Vitest. Exclude `tests/live/**` from the default test project: live cases run only through explicit qualification commands. Install the exact table pins needed here; `.npmrc` uses `save-exact=true`.
- [x] Define the shared schemas. `TaskContract` includes repo ID/path, text, non-goals, allowed/protected paths, provider, environment, selected model/effort, acceptance IDs, verification-plan reference, inclusion manifest and declared limits. `RunRecord` includes phase, blocker, generation, baseline/candidate/session references, repair count, cumulative budgets and pending action IDs. `RuntimeCapabilities` includes exact runtime/adapter/platform/policy fingerprints and per-capability `SUPPORTED | UNSUPPORTED | UNQUALIFIED` with evidence IDs. Model/effort are provider-validated strings, not invented cross-provider enums.
- [x] Write named cases `rejects_unknown_fields_and_unbounded_limits`, `rejects_native_claude_execution`, `doctor_is_passive_and_redacts_values`, `doctor_reports_unqualified_without_data_root`. Assertions include:

```ts
expect(parseTask({...validTask, limits: {...validTask.limits, activeMs: 0}}).ok).toBe(false);
expect(report.qualification).toBe('UNQUALIFIED');
expect(modelCalls).toBe(0);
expect(filesWritten).toEqual([]);
expect(JSON.stringify(report)).not.toContain(fakeSecretValue);
```

- [x] Run `npm test -- tests/contracts.test.ts tests/doctor.test.ts`; require the planned failures, then implement parsing, `--json`, and `doctor`. Inspect only credential-source **presence**, never print values; report subscription mode as unknown unless the official runtime exposes safe metadata. Do not start app-server just to report installed versions. `status` without a database will later be similarly passive.
- [x] Rerun the failed task tests. Expected: both files pass, no fixtures mutate a real repository, and no provider request is made. Capture receipt; review the command surface and boundary schemas.

## Task 2: Durable artifacts, action intents, and ownership generations

**Owner:** sol_engineer. **Files:** Create `src/store/schema.sql`, `src/store/database.ts`, `src/store/artifacts.ts`, `src/store/actions.ts`, `src/store/ownership.ts`, `src/store/control-requests.ts`, `src/contracts/evidence.ts`; test `tests/store.test.ts`, `tests/store-crash.test.ts`.

**Interfaces:** `openStore(root: string): RunStore`; `publishArtifact(store: RunStore, input: AsyncIterable<Uint8Array>, metadata: ArtifactMetadata): Promise<Result<ArtifactRef>>`; `claimRun(store: RunStore, repoId: string, runId: string): Result<OwnerToken>`; `recordIntent(store: RunStore, owner: OwnerToken, intent: ActionIntent): Result<ActionRecord>`; `appendOutcome(store: RunStore, owner: OwnerToken, actionId: string, outcome: ActionOutcome): Result<void>`. `OwnerToken` contains repo/run IDs, monotonic generation and random lease nonce. `ActionRecord` states are `INTENDED`, `DISPATCHED`, `OBSERVED`, `OUTCOME_UNKNOWN`; unresolved intent also needs reconciliation.

Also produce `submitControlRequest(store: RunStore, expectedGeneration: number, request: ControlRequest): Result<string>`. ControlRequest has stable ID, run ID, kind (`CANCEL`, `OBSERVATION`, `INTEGRITY_REVIEW`) and validated payload. Trusted CLI processes may enqueue requests, but only the owning controller consumes them and changes lifecycle. This is a transactional inbox, not a second run owner or a network service.

- [x] Add exact better-sqlite3 pins. Define tables for runs, repo ownership, actions, events, artifacts, checks, qualifications, proposals, knowledge versions and control requests; foreign keys on, WAL, `synchronous=FULL`, 5-second busy timeout. Only this module writes SQL. Migrations are numbered and transactional; no deletion/automatic cleanup operation. Test duplicate control request IDs are idempotent, stale-generation requests are rejected, and enqueuing cancellation does not itself change the run phase.
- [x] Write `single_owner_across_processes`, `rejects_stale_generation`, and table-driven crash cases `before_publish`, `after_publish_before_reference`, `after_intent_before_dispatch`, `after_dispatch_before_ack`. Assert:

```ts
expect(secondOwner.ok).toBe(false);
expect(staleWrite.error.code).toBe('STALE_OWNER');
expect(recovered.unknownActionIds).toContain(actionId);
expect(recovered.replayedActionIds).toEqual([]);
expect(missingArtifactAllowsReady).toBe(false);
```

- [x] Run `npm test -- tests/store.test.ts tests/store-crash.test.ts` to see the missing behavior. Implement temp-file write, flush, hash validation, atomic same-volume publication, then transactional reference; validate hashes on recovery. Never overwrite an existing hash with different bytes. Simulate abrupt process exit, not just a caught exception. Database ownership does not expire into automatic takeover: stale owner requires Task 14 reconciliation.
- [x] Add chunk-aware secret redaction before durable evidence, output caps, explicit excerpt/truncation metadata, and tests for a sentinel secret split across chunks. Redaction is best-effort evidence hygiene; isolation prevents credentials entering output in the first place. If an output limit is hit, stop/drain its producer and record the limit independently.
- [x] Rerun affected task tests. Expected: orphan artifacts are harmless, missing/corrupt referenced data blocks readiness, and dispatch cannot occur without an intent receipt. Review database transitions and fault points.

## Task 3: Native Windows owned-process supervision

**Owner:** sol_engineer. **Files:** Create `native/supervisor/Cargo.toml`, `native/supervisor/Cargo.lock`, `native/supervisor/rust-toolchain.toml`, `native/supervisor/src/main.rs`, `native/supervisor/src/protocol.rs`, `native/supervisor/src/windows.rs`, `src/runtime/supervisor.ts`, `src/contracts/execution.ts`, `tests/support/heartbeat-child.mjs`; test `native/supervisor/tests/windows_ownership.rs`, `tests/supervisor-protocol.test.ts`.

**Interfaces:** `launchOwned(spec: LaunchSpec): Promise<Result<OwnedExecution>>`. `LaunchSpec` contains `{runId,generation,actionId,role}`, absolute executable, argv array, cwd, explicit env, boundary hash, execution authorization, lease TTL and deadline. `ExecutionAuthorization` is either `{kind:'qualified', qualificationRef:string}` or `{kind:'qualification', requestId:string, probeId:string, fixtureRoots:string[]}`. The latter permits only a predeclared disposable probe, never a user task; this allows initial qualification without a circular demand for a prior pass. `OwnedExecution` exposes `describe(): Promise<OwnershipReceipt>`, `fence(): Promise<void>`, `renewLease(sequence:number): Promise<void>`, `drain(reason:string): Promise<DrainEvidence>`, and typed child-output events. Receipts record PID plus creation identity, helper identity and job identity. Drain evidence separates request acknowledgment, root exit, membership emptiness, unresolved executions and timestamps.

- [x] Create the Rust package with exact crate pins from the table. Enable only required Windows Foundation/Security/JobObjects/Threading/Pipes APIs. Define a versioned 4-byte-length-prefixed UTF-8 JSON protocol; serialize child stdout/stderr as **payload**, never as supervisor control messages. Every control message carries the owner/action identity. Close nonessential inherited handles.
- [x] Write `owns_child_before_resume`, `controller_eof_kills_descendants`, `helper_death_closes_job`, `unrelated_same_name_survives`, `job_assignment_failure_never_runs_child`, and TS cases for fragmented, stale, oversize and forged output frames. Required assertions:

```rust
assert_eq!(report.active_processes, 0);
assert!(!report.child_ran_before_assignment);
assert!(unrelated_process.is_running());
```

- [x] Run `cargo test --manifest-path native/supervisor/Cargo.toml --test windows_ownership` and `npm test -- tests/supervisor-protocol.test.ts` for their planned failures.
- [x] Implement a private Job Object with kill-on-close and no breakaway flags. Create the absolute child executable suspended, assign to job, then resume. The helper owns the sole job handle. Explicit inherited-handle list contains only required child stdio; no control pipe/job/store handle. EOF, deadline or lease expiry fences starts and drains. Query actual job accounting for zero members; completion events alone do not prove it.
- [x] Rerun affected checks. These prove helper-owned processes only; brokered Codex/MXC work still needs Task 7. Review unsafe FFI, quoting/argument round trips, and normal exit with a surviving grandchild.


**Coordinator integration clarification (Task 5 dependency):** `LaunchSpec` additionally selects stdin mode (`closed` by default or `pipe`). `OwnedExecution` additionally exposes `writeInput(bytes: Uint8Array): Promise<Result<void>>` and `endInput(): Promise<Result<void>>`. Child stdin bytes are identity-bound payload, never helper control; enforce the control frame bound, reject writes after fence/drain/EOF or for stale identity, and never log input bytes or inherit the helper control pipe. Add a focused stdin/protocol round-trip case. This supplies the stdio transport required by Task 5 without giving the child control authority.


**Coordinator completion clarification (independent review):** `DrainEvidence` also requires `outputComplete: boolean`, `unresolvedOutputStreams: ('stdout'|'stderr')[]`, and `outputCompletedAt: number|null`. Complete output requires both readers finished, no unresolved streams and a timestamp; timeout/error must remain explicitly incomplete. Use one bounded evidence window, enqueue all accepted child output before the terminal frame, and accept no payload afterward. Later verification/readiness requires process drainage AND complete output evidence; never silently upgrade earlier receipts lacking these fields.

## Task 4: WSL supervision and independent command boundaries

**Owner:** sol_engineer. **Files:** Create `native/supervisor/src/linux.rs`, `src/runtime/wsl.ts`, `src/runtime/command-boundary.ts`, `adapters/claude/package.json`, `adapters/claude/package-lock.json`, `adapters/claude/src/verify-command.ts`; modify supervisor dispatch and exports; test `tests/wsl-launch.test.ts`, `tests/command-boundary.test.ts`, `native/supervisor/tests/linux_ownership.rs`.

**Interfaces:** `inspectWsl(distro: string): Promise<WslPrerequisites>`; `launchWslOwned(spec: LaunchSpec, distro: string): Promise<Result<OwnedExecution>>`; `compileCommandBoundary(command: CommandDefinition, profile: BoundaryProfile): Result<LaunchSpec>`. `CommandDefinition` fixes ID, executable/argv/cwd, approved environment keys, timeout, input scope, permitted outputs and expected exit. `BoundaryProfile` fixes platform, read/write roots, denied sensitive roots, command network policy and exact qualification identity.

- [x] Write launch tests `rejects_wsl1_or_missing_systemd_cgroup2`, `never_invokes_shell_with_unquoted_user_text`, `rejects_unqualified_verifier`, `closed_socket_or_missing_seccomp_blocks_wsl`, and Linux ownership cases `double_fork_drains`, `helper_exit_drains_unit`, `other_unit_survives`. Assert `result.error.code === 'CAPABILITY_UNAVAILABLE'` and zero repository commands when prerequisites fail.
- [x] Run `npm test -- tests/wsl-launch.test.ts tests/command-boundary.test.ts` for the planned failures. Implement Windows `wsl.exe --distribution <name> --exec ...` with explicit arguments. The Linux helper is main process of a unique transient user `.service`: `Type=exec`, `ExitType=main`, `KillMode=control-group`, `SendSIGKILL=yes`, `TimeoutStopSec=5s`, `Restart=no`, `Delegate=no`, and finite `RuntimeMaxSec`. Record InvocationID, boot ID and cgroup before dispatch; require recursive `cgroup.events populated=0` to complete drainage. No persistent service or privileged broker.
- [x] Add native verification through the pinned Codex sandbox CLI, owned by the Windows helper, with explicit managed permissions and no unsandboxed fallback. Add WSL verification through pinned `srt --settings <controller-file> -- <executable> ...` inside its owned unit. Compile only fixed registry commands; any shell needed is explicitly recorded and correctly argument-encoded. The WSL wrapper's configuration is mandatory, not inherited from home-directory defaults.
- [x] Require available seccomp Unix-socket restrictions, deny execution-broker sockets/cgroup writes and restrict inherited descriptors. Treat systemd supervision and file/network isolation as separate controls. `wsl.exe` exit does not establish unit exit. Missing prerequisites produce instructions, never an automatic WSL install/restart.
- [x] Rerun the affected TS tests. Run `cargo test --manifest-path native/supervisor/Cargo.toml --test linux_ownership` once red then once after implementing its backend, **only after explicit WSL setup is available**, from a Linux-native checkout. If unavailable, Task 8 remains blocked. Record this separately from mock tests. Never invoke Linux ownership tests against arbitrary existing units.

**Coordinator ownership clarification (Task 4):** Use a second finite transient observer service outside the target cgroup, with a private bounded evidence spool; no persistent service or privileged broker. The observer captures target identity and arms cgroup observation before releasing the actual child. A missed actual populated=0 read stays inconclusive. First execute the single disposable capability probe defined in `.superpowers/sdd/2026-10-13-ouroboros-implementation/task-4-ownership-design.md`; stop dependent work if it cannot establish the observation. Preserve the Windows receipt branch; add explicit `environment: 'wsl2'` ownership/drain records with real target helper, root and observer identities, actual unit/boot/cgroup identity, and complete-output evidence. Never fabricate Windows job fields or a process count for unknown Linux membership. Exact shared schema and manager binding are coordinated before mutation.

**Retained containment correction (Task 4):** Following the inconclusive initial probe, observe the actual recursive populated=0 of a unique active execution slice containing only the captured target-service incarnation. Bind target and observed cgroup paths/identities separately and verify ancestry before exec. The slice uses BindsTo+After the already-active finite observer and StopWhenUnneeded=no; target uses Slice=that slice. Observer stays outside, with no reverse dependency. Persist zero/output evidence before normal slice stop. Observer failure triggers cleanup, never a fabricated pass. One corrected capability check is authorized before dependent implementation; the Task4 design note records sources and probe details.

## Task 5: Pinned Codex app-server adapter

**Owner:** sol_engineer. **Files:** Create `src/providers/provider.ts`, `src/providers/codex/transport.ts`, `src/providers/codex/adapter.ts`, `src/providers/codex/policy.ts`, `src/providers/codex/protocol/0.162.1/` generated bindings, `scripts/generate-codex-protocol.ps1`; test `tests/codex-adapter.test.ts`, `tests/codex-policy.test.ts`.

**Interfaces:** `ProviderAdapter.inspect(): Promise<ProviderInspection>`; `start(input: ProviderStart): Promise<Result<ProviderSession>>`; `resume(input: ProviderResume): Promise<Result<ProviderSession>>`. `ProviderSession` exposes correlated `AsyncIterable<ProviderEvent>`, `interrupt(): Promise<InterruptReceipt>`, `inspectExecution(): Promise<ExecutionInventory>`, and `close(): Promise<DrainEvidence>`. Events distinguish session/turn identity, tool execution, approval, diagnostics, auth/quota errors and turn completion; none may set readiness. `ProviderStart` carries owner, action ID, absolute workspace root, prompt/context artifact refs, selected model/effort, boundary profile, ExecutionAuthorization and mode (`IMPLEMENT` or `REFLECT`). Resume adds the persisted session ID and reconciliation evidence. REFLECT requires a separately tested no-tools configuration; report it unavailable if supported controls cannot express that mode.

- [x] Generate protocol types and JSON schema with the installed pinned CLI's `app-server generate-ts` / `generate-json-schema` subcommands into the named directory; verify exact flags with their own help. Record CLI binary hash, version and generated-schema hash. Do not approximate request field names from old examples. Use `--strict-config` and local stdio; no remote server/daemon sharing.
- [x] Write fixtures for `initialization_order_and_request_correlation`, `denies_unscoped_approval`, `late_generation_event_cannot_mutate_run`, `turn_complete_is_not_ready`, `auth_or_quota_never_falls_back`, `unknown_method_does_not_expand_permissions`. Assertions include `approval.decision === 'deny'`, `paidFallbackCalls === 0`, and `run.phase !== 'READY_FOR_REVIEW'` after a turn completion alone.
- [x] Run `npm test -- tests/codex-adapter.test.ts tests/codex-policy.test.ts`; implement a bounded JSONL decoder, initialization handshake and typed account/session/turn/approval methods from the generated protocol. Launch app-server under Task 3 supervision. Select the qualified MXC profile explicitly; use no global config writes. Disable optional tools/connectors/hooks via supported effective configuration; if a required inherited surface cannot be disabled or constrained, fail qualification rather than assume it disappeared.
- [x] Validate subscription-source metadata and unexpected API-key/provider configuration before a model request. Use runtime-managed credentials in place; do not copy token files into run roots. Record unknown extra-usage configuration as unknown. Interruption fences starts, correlates the exact owned turn and gathers terminal inventory before supervisor drainage.
- [x] Rerun affected tests. Expected: typed protocol behavior passes against fixtures, live capabilities remain `UNQUALIFIED`. Review protocol version drift and permission defaults.

## Task 6: Minimal Claude SDK bridge in WSL2

**Owner:** sol_engineer. **Files:** Create `adapters/claude/tsconfig.json`, `adapters/claude/src/main.ts`, `adapters/claude/src/options.ts`, `adapters/claude/src/session.ts`, `src/providers/claude/adapter.ts`, `src/providers/claude/frames.ts`; modify the adapter package/lockfile; test `tests/claude-options.test.ts`, `tests/claude-adapter.test.ts`.

**Interfaces:** `createClaudeOptions(input: ProviderStart): Result<ClaudeOptionsProjection>`; `createClaudeAdapter(deps: ClaudeAdapterDependencies): ProviderAdapter`. `ClaudeOptionsProjection` is a runtime-validated local contract converted to the pinned SDK's actual `Options`; no casts hiding unsupported controls. The bridge uses Task 3 framing with normalized events and keeps stdout protocol-only.

- [x] Pin the SDK and inspect its declarations/changelog at installation. Use documented streaming `query({prompt: AsyncIterable<SDKUserMessage>, options})`; compile the bridge against the installed types. Record SDK and bundled CLI identities, separately from the Windows Claude executable (`2.1.296` observed, not the WSL qualification target).
- [x] Write `only_bash_is_exposed`, `configuration_is_explicit`, `api_key_presence_blocks_subscription_start`, `hook_error_denies`, `interrupt_receipt_is_not_drain`, `resume_does_not_restore_files`. Assertions include:

```ts
expect(options.tools).toEqual(['Bash']);
expect(options.settingSources).toEqual([]);
expect(options.strictMcpConfig).toBe(true);
expect(options.mcpServers).toEqual({});
expect(options.settings.sandbox.allowUnsandboxedCommands).toBe(false);
expect(options.settings.sandbox.failIfUnavailable).toBe(true);
expect(drainCompleteAfterInterruptOnly).toBe(false);
```

- [x] Run `npm test -- tests/claude-options.test.ts tests/claude-adapter.test.ts`. Implement explicit `settingSources: []`, `skills: []`, `plugins: []`, `strictMcpConfig: true`, empty MCP config, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and `ENABLE_CLAUDEAI_MCP_SERVERS=false`, subject to the pinned type/source check. Preserve managed restrictions. Use adapter-owned inline sandbox settings: enabled, strict availability, no excluded commands or unsandboxed retry, explicit filesystem/network policy.
- [x] Expose only `Bash` initially; inspect/read/edit through its qualified shell sandbox. This deliberately avoids direct-tool path races and remains an official SDK configuration. A global `PreToolUse` gate rejects every nonallowed/malformed request and any boundary bypass field. `allowedTools` is not used as a tool whitelist. Adding direct file tools later requires separate supported enforcement and qualification; do not quietly enable them for convenience. Feed repository instructions as validated context rather than enabling repository hooks.
- [x] Implement streaming events, session IDs, explicit env allowlisting, same-environment resume and interruption. Do not use `--bare` or inherit unexpected API keys. Rerun affected tests; then build the isolated adapter in WSL once its environment exists. Compilation is not live qualification.

## Task 7: Qualify native Codex and its verifier boundary

> Current detailed plan, 2026-10-16: follow [Task 7 documented-integration qualification](2026-10-16-task-7-blocker-resolution.md) and its [corrected design](../specs/2026-10-16-task-7-documented-integration-design.md). They supersede conflicting startup-gate and single-run instructions here. The universal vendor certificate prerequisite is retired; practical startup restrictions and all 32 probes remain. Implementation and each live batch are separate scopes; no new live action is authorized by this update.

**Owner:** sol_engineer with independent sol_reviewer. **Files:** Create `src/qualification/ledger.ts`, `src/qualification/probes.ts`, `src/qualification/codex-windows.ts`, `tests/live/codex-windows.test.ts`, `tests/qualification-ledger.test.ts`, `tests/fixtures/boundary/`, `docs/operations/qualification-codex-windows.md`; extend CLI with explicit `doctor --qualify` dispatch.

**Interfaces:** `qualify(target: QualificationTarget, approval: QualificationRequest): Promise<QualificationReport>`; `lookupQualification(target: QualificationTarget): Result<RuntimeCapabilities>`. Target includes hashes/versions of runtime, adapter, helper, OS, boundary policy, model/effort and verification wrapper. Each probe is `PASS | FAIL | UNTESTED`, with attempt history and evidence refs; overall qualified requires every required probe to pass. QualificationRequest binds fixture roots, approved probe list, permitted endpoints and finite budget.

- [x] Write ledger tests `runtime_change_invalidates_receipt`, `unexecuted_denial_is_not_pass`, `preserves_prior_attempts`, `doctor_without_qualify_has_no_effects`; run `npm test -- tests/qualification-ledger.test.ts` red, implement ledger and explicit dispatch, rerun the affected check.
- [ ] Prepare disposable source/workspace/controller/sibling sentinels, an unreadable fake credential marker, controlled network endpoints, and foreground/descendant heartbeat programs. Never probe by reading actual secrets. Configure denial attempts as explicit test-driver tool requests where possible; a model merely declining to attempt an operation is `UNTESTED`, not proof of OS denial.
- [ ] Implement and review the bounded campaign path in the detailed Task 7 plan, then prepare concrete manifests and obtain separate live-batch approval. The current CLI does not implement the full campaign. Use approved subscription mode with no API-key fallback; do not invoke one aggregate live qualification command from this checklist.
- [ ] Prove one actual permitted subscription request, correlated lifecycle, allowed edit, allowed verifier command, denied source/controller/sibling writes, denied sensitive reads, command-network allow/deny including direct TCP/loopback policy, unapproved config inactivity, and rejection of escaping link/broker attempts. Repeat boundary assertions through the **verifier** runner independently. Required denial must preserve sentinel bytes and record an actual blocked operation.
- [ ] Prove cancellation during foreground work, a surviving/detached descendant, controller/helper death, and pending dispatch. Check exact owned turn terminal inventory, root creation identity/PID exit, stable heartbeat, and zero job membership. Test unrelated same-name process survives. Brokered MXC/WMI escape is a blocking failure, not covered by Job Objects alone. Exercise auth/quota error handling through injected provider responses; label this fault-injection evidence separately from real subscription success—never exhaust credits or revoke login to induce a test.
- [ ] Record report and stop on any required failure. Rerun only the affected failed probe after a supported repair, at most two unsuccessful repairs. No dependent feature work until qualification succeeds. The earlier planning command `codex sandbox windows --help` returned `MXC launcher: CreateProcessInSandbox failed with error code 2 (0x00000002).` It was an unsuccessful help inspection, not a valid sandbox test or a diagnosed defect; capture fresh causal evidence here.

## Task 8: Qualify WSL Claude and its verifier boundary

**Owner:** sol_engineer with independent sol_reviewer. **Files:** Create `src/qualification/claude-wsl.ts`, `tests/claude-qualification.test.ts`, `tests/live/claude-wsl.test.ts`, `docs/operations/qualification-claude-wsl.md`; extend ledger/probe registry without modifying Codex semantics.

**Interfaces:** Implements Task 7 `qualify()` for `{provider:'claude', environment:'wsl2', distro}` using Task 6 adapter and Task 4 verifier. Adds distro/boot identity, kernel, systemd, cgroup, bubblewrap/socat/seccomp and SDK/CLI versions to its target fingerprint.

- [ ] Write `missing_prerequisite_prevents_provider_start`, `all_unix_sockets_warning_blocks_qualification`, and `bash_only_denies_direct_tool_request` in `tests/claude-qualification.test.ts`; assert no model dispatch when strict prerequisites are absent. Run `npm test -- tests/claude-qualification.test.ts` for the planned failures, implement, and rerun this affected offline check. The live file remains opt-in.
- [ ] Confirm WSL2, Linux-native Node/Rust/adapter build, systemd user services, cgroup v2, and runtime-managed Claude subscription login. If setup is missing, present exact prerequisite actions for authorization; do not change an existing distribution or copy Windows auth files automatically. WSL interoperability must be effectively blocked for repository commands even if available to the trusted controller.
- [ ] Run once: `npm run dev -- doctor --qualify --provider claude --environment wsl2 --distro Ubuntu --fixture-root <absolute-disposable-root> --model <configured-model>`. Use Task 7's common permission/evidence probes with the actual Bash tool and independently with `srt` verification.
- [ ] Add cgroup migration, `systemd-run`/D-Bus, Docker/SSH-agent socket, Windows `.exe` launch, Unix-socket creation, inherited control-descriptor, source mount and adapter-file mutation attempts. Assert denied operations and unchanged sentinels. Confirm direct Read/Edit/Write/Agent/MCP tools are unavailable; enabled-tool hook errors deny rather than silently continue.
- [ ] Exercise interrupt/startup races, transport loss, helper death, double-fork descendants and resume checkpoints. Require matching unit InvocationID, recursive cgroup emptiness, stable heartbeat, and preserved unrelated units. Inject auth/quota responses without changing the user's account. Record environment/source/candidate evidence before and after.
- [ ] Record pass/fail/untested per capability and obtain the independent review gate. A WSL Claude failure blocks that required path and the full v1 release; do not silently replace it with native Claude or Codex. WSL Codex is optional future qualification using the same ledger, not an inherited pass.

## Task 9: Capture a stable working baseline without touching the source

**Owner:** sol_engineer. **Files:** Create `src/workspace/inspect.ts`, `src/workspace/paths.ts`, `src/workspace/baseline.ts`, `src/contracts/workspace.ts`, `tests/support/repository.ts`; test `tests/baseline.test.ts`, `tests/path-policy.test.ts`.

**Interfaces:** `inspectRepository(source: string): Promise<Result<RepositoryInspection>>`; `captureBaseline(source: string, inclusion: InclusionManifest, store: RunStore): Promise<Result<BaselineManifest>>`. Inspection returns canonical repo identity, HEAD/index/working-tree provenance, applicable instructions, untracked/ignored summaries and unsupported path types. Manifest entries record relative path, file type/mode, byte length and artifact hash; deletions are explicit. `SnapshotRef` names an immutable manifest artifact and its hash. InclusionManifest explicitly names untracked files and exclusions; no implicit wildcard for ignored content.

- [ ] Create disposable fixture builders for clean Git, staged+unstaged edits to the same file, tracked deletion, binary/CRLF files, explicit untracked inclusion, and source changes during capture. Keep fixture artifacts under test-owned roots, with source before/after hashes. Use raw filesystem bytes; do not run checkout filters, hooks, repository scripts or external diff helpers during inspection.
- [ ] Write `captures_worktree_not_head_or_index`, `records_excluded_untracked_before_dispatch`, `rejects_source_change_during_capture`, and path cases for traversal, drive/UNC/device paths, ADS, reserved names, case collisions, symlink/junction/hardlink escape, submodule and Git filter configuration. Assertions:

```ts
expect(capturedBytes).toEqual(workingTreeBytes);
expect(sourceAfter).toEqual(sourceBefore);
expect(exportContainsPriorWip).toBe(false);
expect(mixedSnapshot.ok).toBe(false);
expect(unsupported.error.code).toBe('UNSUPPORTED_PATH_SEMANTICS');
```

- [ ] Run `npm test -- tests/baseline.test.ts tests/path-policy.test.ts`. Implement NUL-delimited Git metadata reads with literal paths, no shell interpolation, and disabled external diff/filter execution. Read nested applicable instruction files as context only. Reject submodules and link entries in v1, reject multi-link regular files unless safe independent copying can be proven, and inspect ancestor reparse points. Resolve source identity using filesystem identity as well as canonical path to prevent duplicate-run aliases.
- [ ] Capture tracked bytes and only explicit untracked inclusions. Record a complete before/after source manifest, index identity and Git metadata; publish only if stable. This detects observable concurrent edits; do not claim a filesystem-wide atomic snapshot. If stable capture cannot be established, return `NEEDS_INPUT`, never switch to HEAD. Sensitive-looking inclusions require a focused decision.
- [ ] Rerun affected checks; expected: source branch/index/status/bytes remain unchanged, and every omitted needed prerequisite is visible. Review Windows/WSL normalization and injection through filenames.

## Task 10: Independent run checkouts and immutable candidates

**Owner:** sol_engineer. **Files:** Create `src/workspace/materialize.ts`, `src/workspace/candidate.ts`, `src/workspace/patch.ts`; test `tests/materialize.test.ts`, `tests/patch.test.ts`.

**Interfaces:** `materializeBaseline(baseline: BaselineManifest, target: WorkspaceTarget): Promise<Result<RunWorkspace>>`; `captureCandidate(workspace: RunWorkspace, drain: DrainEvidence): Promise<Result<SnapshotRef>>`; `exportPatch(baseline: SnapshotRef, candidate: SnapshotRef, destination: string): Promise<Result<PatchExport>>`. RunWorkspace records private checkout/Git paths, ownership and environment; PatchExport references a binary-capable patch, changed-file manifest, baseline/candidate hashes and portable snapshot artifacts.

- [ ] Write `no_shared_git_metadata_or_hardlinks`, `materialization_preserves_bytes_and_modes`, `candidate_requires_drain`, `binary_new_and_deleted_files_export`, and `source_changes_after_capture_are_reported`. Assert:

```ts
expect(runGitCommonDir).not.toBe(sourceGitCommonDir);
expect(materializedManifest).toEqual(baselineManifest);
expect(captureWhileRunning.error.code).toBe('EXECUTION_NOT_DRAINED');
expect(applyToDisposableBaseline(patch).manifest).toEqual(candidateManifest);
expect(sourceAfter).toEqual(sourceBefore);
```

- [ ] Run `npm test -- tests/materialize.test.ts tests/patch.test.ts`. Create independent Git metadata using a controlled local clone without hardlinks or checkout, then overlay captured bytes; never use a linked worktree. Disable repository hooks/filters, credentials/remotes and external diff in the run checkout; do not execute original Git config. Reject unsupported alternate-object arrangements. No synthetic baseline commit is required: manifests define the baseline.
- [ ] Transfer WSL snapshots via validated manifest entries and length-bounded byte streams, not extraction of arbitrary tar paths. Materialize inside the selected Linux filesystem. Verify the result equals the baseline before granting worker access. Dependencies are separately provisioned through recorded sandboxed setup commands, not copied from the original installation.
- [ ] Freeze by fencing/draining execution, capture to controller-owned artifacts, and generate baseline-to-candidate diffs in a disposable export materialization with controlled Git settings. Include new/untracked candidate files, deletions and binary changes. Protect verification inputs; never make exported evidence authoritative by its public location alone.
- [ ] Rerun affected checks. Apply the patch only to a **disposable copy** in the test, compare complete manifests, and verify the source remains unchanged. Review run workspace and export containment.

## Task 11: Task intake, acceptance plans and test-integrity review

**Owner:** implementation_worker; sol_reviewer checks authority boundaries. **Files:** Create `src/task/prepare.ts`, `src/task/context.ts`, `src/verification/plan.ts`, `src/verification/integrity.ts`, `src/contracts/verification.ts`, `src/contracts/memory.ts`, `examples/node-project.profile.json`, `examples/bugfix.task.json`; test `tests/task-prepare.test.ts`, `tests/integrity.test.ts`.

**Interfaces:** `prepareTask(request: TaskRequest, inspection: RepositoryInspection, profile: RepositoryProfile): Result<PreparedTask>`; `buildContext(task: PreparedTask, workspace: RunWorkspace, lessons: ApprovedTopic[], evidence: ArtifactRef[]): Promise<ContextBundle>`; `assessIntegrity(baseline: SnapshotRef, candidate: SnapshotRef, plan: VerificationPlan): IntegrityAssessment`. PreparedTask contains TaskContract, immutable VerificationPlan, setup steps and explicit unanswered decisions. Plan entries use Task 4 CommandDefinition; each acceptance criterion maps to required command IDs or a recorded human observation. IntegrityAssessment lists changed protected surfaces and required reviews; it never declares semantics safe solely from a diff heuristic.

Define the ApprovedTopic contract here so context assembly compiles before memory services exist: immutable ID/version, repo/scope, rule/applicability/limitations, source/evidence fingerprints and review disposition. Tests pass an empty topic list or approved fixture values; Task 15 adds persistence and retrieval.

- [ ] Write `green_existing_suite_does_not_prove_new_feature`, `missing_command_or_acceptance_blocks_edits`, `nested_instructions_cannot_expand_authority`, `new_untracked_prerequisite_requires_inclusion`, `test_discovery_and_script_changes_require_review`. Assertions:

```ts
expect(prepared.pendingDecisionCodes).toContain('ACCEPTANCE_EVIDENCE_REQUIRED');
expect(proposedModelCommandIsRegistered).toBe(false);
expect(integrity.requiredReviews).toContainEqual(expect.objectContaining({path:'package.json'}));
expect(unapprovedTestChangeAllowsReady).toBe(false);
```

- [ ] Run `npm test -- tests/task-prepare.test.ts tests/integrity.test.ts`. Implement a repo profile supplied explicitly with stable command IDs, absolute runtime resolution, arguments, environment allowlist, outputs and acceptance mappings. V1 takes task/profile JSON with a human-readable task text field; it does not need another planning-model integration. Routine task scope is approved by `run`; material unresolved scope pauses before dispatch.
- [ ] For bugs, run a planned baseline reproduction where practical and retain its receipt separately from candidate verification. For features, require an independent behavior expectation even if existing tests pass. Store independent acceptance assets in controller-owned artifacts and expose read-only to verification; do not let the worker replace them. Human-only checks remain pending until the user records the actual observation.
- [ ] Detect changes to existing assertions/tests, fixture data, skips, setup scripts, runner config, dependency lockfiles and discovery patterns conservatively. Require user integrity review for protected semantic changes in v1; a model review may advise but cannot grant approval. Record reviewer disposition against exact diff and plan hashes. Changed plans create a new version with explicit authorization; they do not erase old failures.
- [ ] Rerun affected checks. Review task/profile examples and byte-bounded context assembly: current repository content, applicable instructions, approved fresh topics and exact evidence excerpts; repository/log text never becomes permission policy.

## Task 12: Authoritative verification with input freshness

**Owner:** sol_engineer. **Files:** Create `src/verification/runner.ts`, `src/verification/fingerprint.ts`, `src/verification/scheduler.ts`, `src/verification/evidence.ts`; test `tests/verification.test.ts`, `tests/check-freshness.test.ts`.

**Interfaces:** `runCheck(check: CommandDefinition, candidate: SnapshotRef, context: VerificationContext): Promise<Result<CheckResult>>`; `fingerprintInputs(check: CommandDefinition, candidate: SnapshotRef, environment: EnvironmentFingerprint): string`; `scheduleChecks(plan: VerificationPlan, prior: CheckResult[], candidate: SnapshotRef, authorizations: RevalidationGrant[]): CheckSchedule`. CheckResult includes check/plan/action IDs, command, environment/input/candidate hashes, times, exit/signal, classification, output refs, input mutation and `FRESH | STALE`. Schedule returns runnable failed/not-yet-run checks, reused fresh passes and pending revalidation IDs.

- [ ] Write `argv_is_data_not_shell_text`, `fails_on_candidate_input_mutation`, `no_green_without_acceptance_evidence`, `reuses_unchanged_pass`, `marks_pass_stale_after_dependency_or_env_change`, `only_reruns_affected_failure`, and `timeout_drains_descendants`. Assertions:

```ts
expect(schedule.reusedCheckIds).toEqual(['unchanged-pass']);
expect(schedule.pendingRevalidationIds).toEqual(['changed-pass']);
expect(schedule.runnableCheckIds).toEqual(['affected-failure']);
expect(mutatingResult.classification).toBe('INPUT_MUTATION');
expect(timedOutResult.classification).toBe('TIMEOUT');
```

- [ ] Run `npm test -- tests/verification.test.ts tests/check-freshness.test.ts`. Execute registered commands through the qualified environment boundary and owned supervisor only. Await drainage; preserve stdout/stderr/exit/timing and excerpts through Task 2. Distinguish failed assertion, compile, policy denial, missing prerequisite, timeout and controller defect.
- [ ] Hash the entire candidate input manifest by default, plus plan/command, dependency lockfiles and actual tool/environment identities. Permit a narrower input scope only when the profile supplies a reviewed, complete dependency closure. A model-suggested file list is insufficient. Dependency/setup changes invalidate fingerprints.
- [ ] Materialize checks from immutable candidates with separately declared writable caches/outputs. If source-adjacent writes are necessary, use a disposable copy and compare all inputs afterward. Exclude generated outputs from export only by explicit profile definition. A process that changes an input invalidates the check even when it exits zero.
- [ ] Rerun affected tests. Expected: green checks are never repeated automatically; stale passes yield a named narrow revalidation request; full checks run only after targeted changes have settled. Review evidence sufficiency and timeout behavior.

## Task 13: The bounded controller loop and readiness gate

**Owner:** sol_engineer. **Files:** Create `src/controller/state.ts`, `src/controller/run.ts`, `src/controller/readiness.ts`, `src/controller/budgets.ts`, `tests/support/fake-provider.ts`; test `tests/controller.test.ts`, `tests/readiness.test.ts`.

**Interfaces:** `executeRun(runId: string, deps: ControllerDependencies): Promise<RunRecord>`; `transition(run: RunRecord, event: ControllerEvent): Result<RunRecord>`; `evaluateReadiness(input: ReadinessInput): ReadinessDecision`. ControllerDependencies supplies store, provider adapter, qualified supervisor/workspace/verifier services, monotonic clock and reviewed task. ReadinessDecision is `{ready:boolean, blockers:ReadinessBlocker[]}`. Only this module can persist `READY_FOR_REVIEW`; fake providers produce normalized events/candidates, never readiness.

- [ ] Write scenarios `initial_failure_then_two_failed_repairs_stops`, `unchanged_patch_stops_early`, `provider_done_is_not_success`, `quota_checkpoint_preserves_candidate`, `exhausted_budget_drains`, `stale_pass_blocks_ready`, and table-driven exclusion for every readiness condition. Assert:

```ts
expect(run.repairCount).toBe(2);
expect(run.phase).toBe('REPAIR_LIMIT_REACHED');
expect(providerCorrectiveStarts).toBe(2);
expect(noProgress.phase).toBe('NO_PROGRESS');
expect(quotaRun.phase).toBe('WAITING_FOR_QUOTA');
expect(readyWithMissingArtifact.ready).toBe(false);
```

- [ ] Run `npm test -- tests/controller.test.ts tests/readiness.test.ts`. Implement the approved normal phases and separate blocker/reason, plus all approved checkpoint states. Prepare → durable intent → provider implementation → fence/drain → candidate → integrity gate → verification. Build each repair request from current bytes and referenced evidence, with a supported diagnosis and affected failed checks; retain prior attempts independently.
- [ ] Keep `run`/`resume` as foreground controllers with no installed daemon. Consume Task 2 control requests between events and on a 250-ms maximum polling interval while waiting; renew supervisor leases independently of provider output. On a durable idle checkpoint, drain first and release ownership explicitly. On a crash, retain ownership uncertainty for reconciliation. Test another CLI process can enqueue cancel while the provider stream is stalled.
- [ ] Count unsuccessful corrective candidates only after their required affected checks fail. Auth/quota/infra stops do not count as code repairs. Identical candidate/failure without new evidence stops as `NO_PROGRESS`; repeated unsupported actions do likewise. A checkpoint never resets repairs, cumulative time or output usage. Use monotonic accounting during execution and durable timestamps/segments across restart; charge uncertain crash intervals conservatively rather than granting fresh budgets.
- [ ] Make readiness require intact baseline/candidate, fresh required passes, acceptance coverage, resolved integrity/human observations, no running execution, valid evidence, current qualification and no unknown action. Missing prerequisites stop as `BLOCKED` or `NEEDS_INPUT`; no classifier or provider event bypasses the gate.
- [ ] Rerun affected checks. Review every state edge and accounting boundary. Expect a complete deterministic run with a fake adapter; do not describe this as live provider task acceptance.

## Task 14: Cancellation, reconciliation and bounded resume

**Owner:** sol_engineer. **Files:** Create `src/controller/cancel.ts`, `src/controller/recover.ts`, `src/controller/resume.ts`; test `tests/cancel.test.ts`, `tests/recovery.test.ts`.

**Interfaces:** `cancelRun(runId: string, deps: ControllerDependencies): Promise<RunRecord>`; `reconcileRun(runId: string, deps: ControllerDependencies): Promise<RecoveryReport>`; `resumeRun(runId: string, decision: ResumeDecision, deps: ControllerDependencies): Promise<RunRecord>`. RecoveryReport identifies owned executions, unknown action IDs, changed environment/workspace and required decisions. ResumeDecision includes the specific blocker resolution, named revalidation grants or budget extension; it does not authorize replay of arbitrary actions.

- [ ] Write `interrupt_ack_remains_draining`, `stale_owner_cannot_cancel_new_owner`, `unknown_dispatch_not_replayed`, `crash_after_verify_before_ready_reconciles`, `resume_keeps_repair_and_budget_counts`, `changed_runtime_requires_requalification`, and `unowned_terminal_prevents_whole_job_fallback`. Assertions:

```ts
expect(afterInterrupt.phase).toBe('DRAINING');
expect(recovery.unknownActionIds).toEqual([uncertainActionId]);
expect(providerReplayCalls).toBe(0);
expect(resumed.repairCount).toBe(checkpoint.repairCount);
expect(unrelatedProcessKilled).toBe(false);
```

- [ ] Run `npm test -- tests/cancel.test.ts tests/recovery.test.ts`. A second CLI process enqueues a generation-bound cancel request without becoming owner; the controller fences new intents first, durably records cancel intent, requests provider interruption, then reconciles exact owned execution and drains through supervisor. If the controller is absent, reconcile before taking over. Publish `CANCELLED` only after all termination evidence and checkpoint durability hold. After evidence timeout remain `DRAINING`/`RECOVERY_REQUIRED`, visibly unresolved.
- [ ] On restart acquire/reconcile ownership before advancing generation. Verify artifacts, workspace, session and runtime fingerprint; inspect INTENDED/DISPATCHED actions. A provider conversation resume does not prove command completion or restore files. Unknown effects require inspection and a concrete user recovery decision; never generic retry of the last turn.
- [ ] Permit auth/quota resume only after runtime-managed readiness and explicit bounded continuation. Revalidation grants bind exact check IDs and current inputs; budget extensions add to retained cumulative usage. Provider/environment changes create a new explicit segment and new capability gate.
- [ ] Rerun affected checks, keeping Task 7–8 live termination receipts as separate evidence. Review process ownership and idempotency claims.

## Task 15: Proposed lessons and reviewed project knowledge

**Owner:** implementation_worker; sol_reviewer checks promotion boundaries. **Files:** Create `src/memory/propose.ts`, `src/memory/review.ts`, `src/memory/retrieve.ts`, `src/memory/consolidate.ts`; extend `src/contracts/memory.ts`; test `tests/memory.test.ts`.

**Interfaces:** `proposeLessons(runId: string, deps: MemoryDependencies): Promise<Result<LessonProposal[]>>`; `reviewProposal(id: string, decision: LessonDecision): Result<ApprovedTopic | null>`; `retrieveTopics(repoId: string, scope: string[], candidate: SnapshotRef, byteBudget: number): ApprovedTopic[]`; `proposeReplacement(topicIds: string[]): Result<ReplacementProposal>`. MemoryDependencies gives read-only evidence and a bounded same-provider synthesis adapter. LessonDecision is accept/edit/reject with exact proposal version; proposals require applicability, limitation, source snapshot and evidence refs. ApprovedTopic versions are immutable.

- [ ] Write `no_lesson_is_valid`, `proposed_lesson_is_not_retrieved`, `unsupported_or_tactical_note_rejected`, `stale_evidence_excludes_topic`, `replacement_preserves_input_versions`, and `memory_failure_does_not_fail_verified_patch`. Assert:

```ts
expect(retrievedProposalIds).toEqual([]);
expect(afterRejectedConsolidation.runPhase).toBe('READY_FOR_REVIEW');
expect(originalApprovedVersionStillExists).toBe(true);
expect(repoInstructionFileWrites).toEqual([]);
```

- [ ] Run `npm test -- tests/memory.test.ts`. Implement automatic evidence capture plus optional post-verification synthesis using ProviderStart mode `REFLECT`: compare recorded failures/final changes and require typed proposal data or `NO_LESSON`. Use no tools (`tools: []` for Claude; the supported and tested equivalent for Codex); no command or writable task workspace is granted. Give it a 2-minute sub-budget within remaining run budget; skip/report if the mode is unqualified or unavailable. Validate all model output in the controller; unsupported provenance cannot become a proposal.
- [ ] Store topic index and versioned Markdown in trusted project storage. Accept/edit/reject is a user action; acceptance never edits repository AGENTS.md/CLAUDE.md or provider-global memory. Retrieve only approved fresh topics whose scope matches, under the 32-KiB byte limit. Deterministic scope/path matching first; no vector database or Jev dependency.
- [ ] Consolidation produces a proposed replacement set, preserving prior approved versions until explicit review. Changes to supporting code/verification assumptions mark affected topics stale. Capture outcomes, repairs and retrieval decisions; an enforceable lesson can suggest a separate lint/test task but cannot install it.
- [ ] Rerun affected tests. Review automatic synthesis as an advisory boundary and reports that make no model-training/improvement claim without held-out evaluation.

## Task 16: Complete the CLI and reviewable delivery bundle

**Owner:** implementation_worker. **Files:** Create `src/cli/run.ts`, `src/cli/status.ts`, `src/cli/review.ts`, `src/cli/memory.ts`, `src/cli/render.ts`, `src/delivery/report.ts`; modify `src/cli/main.ts`; test `tests/cli.test.ts`, `tests/delivery.test.ts`.

**Interfaces:** `createAppServices(dataRoot: string): AppServices` composes earlier services; `buildDelivery(runId: string, services: AppServices): Promise<Result<DeliveryBundle>>`. AppServices contains doctor, task preparation/controller lifecycle, review/export and memory services; only mutations open a writable store. DeliveryBundle includes patch, manifest/snapshot refs, acceptance matrix, exact check evidence, source-current comparison, environment/provider identity and unresolved external gates. It includes an unverified status when readiness fails.

- [ ] Write `status_without_store_is_read_only`, `run_requires_profile_and_task_contract`, `review_never_applies_or_commits_patch`, `delivery_rechecks_candidate_and_artifacts`, `human_observation_binds_candidate`, `memory_accept_is_explicit`. Assert zero model calls for status/review, original source bytes unchanged, and no verified label when evidence is stale/missing.
- [ ] Run `npm test -- tests/cli.test.ts tests/delivery.test.ts`. Implement these concrete command forms with structured `--json` equivalents:

```text
ouroboros doctor [--json]
ouroboros doctor --qualify --provider codex|claude --environment windows|wsl2 [--distro Ubuntu] --fixture-root <path> --model <id>
ouroboros run --repo <path> --task <task.json> --profile <profile.json> --provider codex|claude --environment windows|wsl2 [--distro Ubuntu]
ouroboros status <run-id> [--json]
ouroboros cancel <run-id>
ouroboros resume <run-id> --decision <decision.json>
ouroboros review <run-id> [--export <directory>]
ouroboros review <run-id> --record-observation <observation.json>
ouroboros review <run-id> --record-integrity-review <review.json>
ouroboros memory list --repo <path>
ouroboros memory review <proposal-id> --decision accept|reject [--edited-rule <file>]
```

- [ ] Use ordinary terminal messages for next action, changed files and incomplete gates; expose protocol details through evidence links. Exit codes: `0` successful command/ready delivery, `2` invalid input, `3` blocked or awaiting input/auth/quota/revalidation, `4` failed/no-progress/repair-limit, `130` completed cancellation. Status/review remain successful read operations while showing the run's actual phase; an unverified export does not change the run.
- [ ] Before export, validate candidate/evidence identity and include checksums. Render source changes since baseline as a clear warning for later manual application; do not overwrite them. Escape terminal control characters from repository/log data. Record observations/reviews against exact candidate/plan hashes, preventing reuse after edits. Live-run mutations go through the control inbox; checkpointed runs reconcile/claim ownership before applying a decision. Reading review/status never claims execution ownership.
- [ ] Rerun affected tests. Review help examples and a complete fake-provider CLI transcript through run → review and run → cancel/resume.

## Task 17: Independent end-to-end engineering acceptance

**Owner:** sol_engineer with independent sol_reviewer. **Files:** Create `tests/e2e/engineering.test.ts`, `tests/e2e/failure-recovery.test.ts`, `tests/fixtures/engineering/bug/`, `tests/fixtures/engineering/feature/`, `tests/fixtures/engineering/repair-limit/`, `scripts/run-live-acceptance.ts`, `docs/operations/acceptance-matrix.md`; add `acceptance:live` package script.

**Interfaces:** `runAcceptanceCase(input: AcceptanceCase, services: AppServices): Promise<AcceptanceCaseReport>`. Cases fix fixture baseline, independently stored oracle, task/profile, runtime target and expected terminal status. Reports link all receipts and distinguish deterministic adapter simulation from live provider runs.

- [ ] Define three small Node fixtures: an inclusive date-range bug with a known failing edge case; a feature adding a documented validation behavior while old tests already pass; and a scripted provider that produces an initial wrong candidate plus two different failed repairs. Add pre-existing staged/unstaged WIP, an explicitly included new file, and a binary file to the bug fixture. Keep the independent oracle outside worker writes.
- [ ] Write end-to-end assertions:

```ts
expect(bug.baselineOraclePassed).toBe(false);
expect(bug.finalOraclePassed).toBe(true);
expect(feature.oldTestsPassedInitially).toBe(true);
expect(feature.newAcceptancePassed).toBe(true);
expect(failed.status).toBe('REPAIR_LIMIT_REACHED');
expect(failed.unsuccessfulRepairs).toBe(2);
expect(allCases.sourceAfter).toEqual(allCases.sourceBefore);
expect(allCases.incrementalPatchContainsPriorWip).toBe(false);
```

- [ ] Run `npm test -- tests/e2e/engineering.test.ts tests/e2e/failure-recovery.test.ts` once to expose integration gaps; fix supported failures and rerun only the affected failed case. Include crashed dispatch, interrupted descendant and stale-pass revalidation flows through the real CLI/store with simulated provider events. Do not force real subscription exhaustion or rely on an LLM voluntarily making exactly two errors.
- [ ] After deterministic cases and both live capability gates pass, run `npm run acceptance:live -- --provider codex --environment windows` and separately `npm run acceptance:live -- --provider claude --environment wsl2 --distro Ubuntu`. Each invokes the bug and feature cases once with fixed task/profile/oracle. It reuses qualification receipts only if every target fingerprint matches; these are task-acceptance checks, not repeats of boundary probes. Failed-task repair-limit behavior remains explicitly deterministic fault-injection evidence, plus live adapter failure mapping established earlier.
- [ ] Inspect delivered patches by applying them to disposable captured baselines and running the independent oracles there within their qualified boundary. Treat this delivery-oracle check as a distinct planned acceptance check, not a repeat of the project's earlier successful checks. No writes back to actual source. Record exact provider/model/platform, patch scope, human integrity decisions and remaining gates.
- [ ] Review the acceptance matrix. No release-ready claim if either required live provider cannot complete the agreed task cases. Stop after the repair bound with the actual evidence; do not tune a failing fixture into a meaningless pass.

## Task 18: Local packaging, operating guide and final evidence review

**Owner:** implementation_worker; independent sol_reviewer for whole-change review. **Files:** Create `README.md`, `docs/operations/setup.md`, `docs/operations/usage.md`, `docs/operations/recovery.md`, `docs/operations/release-evidence.md`, `scripts/check-package.mjs`, `scripts/package-local.ps1`; update package scripts and the approved plan's completion boxes only when evidence supports them.

**Interfaces:** `check-package.mjs` checks the built local distribution against its file manifest and reports missing runtime/helper files without starting a provider. `package-local.ps1` produces a user-local archive with CLI, Windows helper and reproducible WSL adapter source/lockfile instructions; no global npm install, service registration, login change or publication.

- [ ] Document prerequisites and the actual qualified combinations, including WSL subscription sign-in, exact SDK/runtime pins, native helper builds, Bash-only Claude tools, finite budgets, profile setup, protected review and explicit revalidation. Show one end-to-end task submission and its review bundle. Document restoring access/reconciling a stopped run without replay or deleting evidence.
- [ ] Add package manifest assertions for CLI entrypoint, supervisor binary, schemas and adapter source/lockfiles, plus absence of credentials, run stores and test fixtures. Run `node scripts/check-package.mjs` against an intentionally incomplete temporary package and expect named missing-file failures; implement packaging and rerun that failed package check.
- [ ] Run the deferred whole-project static checks once after code has settled: `npm run typecheck`, `npm run build`, and `cargo fmt --manifest-path native/supervisor/Cargo.toml -- --check`. Build each helper target with its pinned lockfile and record hashes. Compile the WSL bridge on its actual platform; previous targeted tests do not replace this build. If an earlier pass becomes stale, list the affected revalidation instead of repeating all suites.
- [ ] Produce a release report from valid task receipts and acceptance results. Separate deterministic tests, Windows/WSL helper tests, live capability probes, live bug/feature tasks, injected auth/quota/repair-limit cases, and manual reviews. Hosted CI, public distribution and production deployment remain `NOT_RUN / OUT_OF_SCOPE`. Report all unresolved limitations and any dropped capabilities explicitly.
- [ ] Have an independent reviewer inspect the entire final change against the spec, permission boundaries, crash paths and evidence. Resolve actionable findings with smallest supported changes and targeted affected checks. Deliver the local archive, review bundle examples and operating guide; do not commit, push, register a service or publish a package without separate authorization.

## Spec coverage and planning self-review

| Approved design sections | Implementing tasks |
| --- | --- |
| 1–3: purpose, architecture, contracts | 1, 5–6, 11, 16 |
| 4: providers/subscription/capabilities | 5–8, 14 |
| 5: baseline/workspace/patch | 9–10, 17 |
| 6: permissions and trusted authority | 2–8, 11–12 |
| 7: lifecycle/budgets/readiness | 11–14 |
| 8: verification/integrity/evidence | 2, 11–13, 17 |
| 9: persistence/ownership/recovery | 2–4, 14 |
| 10: reviewed memory/improvement | 15–16 |
| 11: routing/Jev | Deterministic context/profile routing in 11 and 15; optional model router deliberately deferred |
| 12: qualification/e2e/release | 7–8, 17–18 |
| 13: CLI | 1, 7–8, 16 |
| 14–15: staged delivery/documentation | Gates A–D, 18 and source notes below |

Coordinator self-review completed: every spec section maps to a task, all five Review Focus inputs have owning tests, and shared interfaces/dependencies were checked. Corrections included initial qualification authorization, cross-process control requests, explicit offline/live test separation and the approved-topic contract's creation order. Structural validation passed for 18 sequential tasks, 95 unchecked implementation steps, required task sections, balanced code fences, the spec link and absence of unresolved placeholders/trailing whitespace. No product tests or live qualification were run as plan validation.

## Documentation basis and outstanding qualification

The approved design contains the broader research/source list. These primary sources support the concrete implementation choices; runtime types and behavior must still match the selected pins:

- [Codex app-server](https://learn.chatgpt.com/docs/app-server), [native Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox), and [WSL support](https://learn.chatgpt.com/docs/windows/wsl): use supported local protocol and qualify the selected environment.
- [Claude SDK configuration](https://code.claude.com/docs/en/agent-sdk/configuration), [feature loading](https://code.claude.com/docs/en/agent-sdk/claude-code-features), [permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [hooks](https://code.claude.com/docs/en/agent-sdk/hooks), and [streaming](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode): explicit SDK controls and tool boundaries.
- [Claude subscription SDK support](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): subscription usage is supported; account eligibility, selected-model access and extra usage still require current runtime evidence.
- [Claude sandbox](https://code.claude.com/docs/en/sandboxing) and [Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime): shell isolation and standalone verifier candidate. Neither process supervision nor a directory name substitutes for a qualified sandbox.
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [assignment](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject), and [handle inheritance](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute): native ownership mechanics and limits.
- [systemd kill behavior](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml), [service lifetime](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml), [cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html), [WSL systemd](https://learn.microsoft.com/en-us/windows/wsl/systemd), and [WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config): Linux ownership and setup prerequisites.
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) and [Vitest](https://vitest.dev/guide/): selected storage/test libraries. Registry version lookups established candidate pins, not compatibility or successful installs.

No Ouroboros runtime has been qualified by this plan. Installed version inventory, prior projects' experiences, documented APIs and mock tests must never be presented as live Ouroboros proof. The failed help inspection noted in Task 7 remains undiagnosed and is not a reason to weaken restrictions.

## Task 7 continuation result, 21 October 2026

The [successor completion plan](2026-10-21-task7-completion.md) is implemented and independently accepted offline, with 1,246 reconciled passing assertions across 49 files and passing final production typecheck/root build. Actual owned version and source-catalog preparation were accepted. First fixture materialization then failed on package-version `0.163.0-win32-x64` versus executable-version `0.163.0` comparison, before store/fixture creation. Dependent execution stopped without retry. Task 7 remains **INCOMPLETE: five blockers OPEN, 0/32 probes accepted**; no ordinary trial, metadata, strict pair or probe ran. Historical counters and failures remain preserved. See the [actual result](../../../.superpowers/sdd/2026-10-21-task7-completion/result.md) for measured preparation, independent stopped-state review and preservation limits. Task 8 and later qualification-dependent work remain outside this continuation.
