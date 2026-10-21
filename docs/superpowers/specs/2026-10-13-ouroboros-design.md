# Ouroboros: subscription-backed software engineering harness

> Runtime contract update, 2026-10-21: the [authorized flexible-runtime continuation](../plans/2026-10-21-flexible-runtime-support.md) replaces fixed release allowlists with immutable per-run executable/control identities, Node 24 minimum plus capability checks, and compatibility observations in existing owned startup exchanges. Generated schemas and exact versions below remain historical evidence. Qualification is still bound to exact actual target identities and never transfers automatically to a newer runtime. This update grants no live campaign retry or qualification acceptance.

> Task 7 update, 2026-10-16: the [documented OAuth/app-server integration design](2026-10-16-task-7-documented-integration-design.md) governs Codex startup admission and qualification. It retains managed ChatGPT sign-in for personal v1, documents the supported third-party OAuth alternative, and supersedes the later proposed universal pre-process certificate requirement. All five blockers remain open; this documentation correction grants no live-run permission.

Date: 2026-10-13

Status: Written design approved by the user on 2026-10-13. This document does not authorize implementation, installation, commits, publication, or deployment. The next artifact is a separate, detailed implementation plan for review.

## 1. Purpose and agreed brief

Ouroboros is a personal, local software engineering tool. The user supplies a scoped task in an existing repository and receives a verified local patch for review. It coordinates an official coding-agent runtime, applies explicit task and execution boundaries, records what happened, and proposes useful lessons for later runs.

The first release must:

- Provide a terminal interface launched from Windows PowerShell.
- Support either Codex or Claude through the user's subscription authentication and official runtime interfaces.
- Prefer native Windows execution where the required capabilities are available; use WSL2 where necessary.
- Preserve the original checkout and work in progress.
- Establish acceptance criteria and verification commands before implementation.
- Drive a bounded implementation-and-repair loop using actual evidence.
- Separate provider completion, local verification, human review, hosted CI, and deployment outcomes.
- Retain resumable run records and require demonstrated process cleanup on cancellation.
- Capture lessons automatically, with user review before promotion into project knowledge.
- Follow current official documentation, with version-specific qualification rather than inferred compatibility.

Success means the controller can produce an unchanged candidate snapshot, its incremental patch, and sufficient evidence that the agreed local acceptance criteria passed. The output status is `READY_FOR_REVIEW`. It does not mean the patch has been accepted, committed, merged, deployed, or qualified in production.

### 1.1 Scope boundaries

Version 1 handles one scoped task at a time per source repository. It supports bug fixes, bounded features, refactors, and test repairs where acceptance criteria can be stated. Tasks requiring a large product design return a scope question before edits.

The controller is written in TypeScript on a supported Node.js LTS release. Target repositories are not required to use TypeScript. Each repository must have an explicit command and acceptance profile; the first end-to-end qualification fixtures use a small TypeScript/Node repository. Other toolchains are supported only after their environment and commands pass preflight.

Version 1 excludes a dashboard, continuous issue discovery, automatic publication, unattended repository-policy changes, automatic provider switching, mandatory Jev integration, and a custom Windows sandbox for Claude. It does not attempt to recreate the providers' internal coding loops or train model weights.

### 1.2 Interpretation of the supplied material

The supplied blueprint is input to this design, not executable authority. The useful concepts are persistent project context, incremental work, external verification, typed routing, bounded feedback, and memory consolidation. The viral quote, adoption statistic, constant-cost routing claims, and a green test run alone do not establish architectural guarantees.

The original sample's model-selected shell commands, unrestricted paths, partial search/replace application, in-memory-only loop state, and automatic instruction appends are not retained. The official runtimes perform implementation; a separate controller establishes scope, verification, records, and readiness.

## 2. Architectural decisions

### 2.1 Chosen approach

Use a shared local controller with provider-specific adapters around the official coding runtimes. This gives Ouroboros control of task lifecycle and evidence while retaining supported provider behavior for model calls, coding tools, context management, authentication, and sessions.

Alternatives considered:

| Approach | Assessment |
| --- | --- |
| Official runtimes plus shared controller | Selected. Supports explicit lifecycle and evidence without rebuilding the coding agent. |
| Repository skills and hooks alone | Useful integrations, but insufficient ownership of cross-run recovery, verification evidence, and provider-independent status. |
| Custom agent loop over model APIs | More control, but substantially more tool, authentication, context, and recovery machinery. Conflicts with the preference to stay close to documented runtimes. |

### 2.2 Execution environments

The user always interacts with the Windows CLI. Execution placement is a property of each run.

| Execution path | Version 1 policy |
| --- | --- |
| Codex on native Windows | Preferred for Windows projects. Use a qualified native sandbox; MXC is the preferred candidate where supported. |
| Claude inside WSL2 | Preferred Claude path for autonomous command execution because Claude's native Windows command sandbox is unavailable in the documentation reviewed. |
| Codex inside WSL2 | Supported fallback for Linux toolchains or an unavailable native capability, after independent qualification. |
| Claude on native Windows | Documented runtime support does not establish the required command isolation. Autonomous implementation through this path is outside the first release. |

Running everything in WSL2 would simplify environment uniformity but exclude or complicate Windows-specific tooling. Providing a new Windows sandbox for Claude would add unnecessary scope. The selected hybrid keeps the front end consistent and qualifies execution paths separately.

The environment is selected and recorded before edits. Agent commands and authoritative verification use that same environment. A Windows-only task cannot silently be treated as verified by a Linux run. Switching environment or provider creates a new execution segment with fresh preflight and explicit user direction; it is not an automatic fallback.

WSL2 is an execution environment, not a complete isolation guarantee. Its Windows interoperability, mounts, sockets, tools, and network access must be included in qualification. Linux-native run workspaces avoid simultaneous Windows and Linux writes and avoid sharing platform-specific dependency directories.

## 3. Components and contracts

Use strict runtime-validated schemas at every process and persistence boundary. Zod is the proposed schema library; exact dependency versions belong in the implementation plan and lockfile. Do not copy unsupported fields from the supplied Jev examples.

| Component | Responsibility | Inputs and outputs | Does not own |
| --- | --- | --- | --- |
| CLI | Task submission, progress, cancellation, resume, patch and lesson review | Validated user requests and controller views | Provider credentials or worker permissions |
| Repository/workspace manager | Discover instructions, capture baseline, prepare task workspace, export incremental patch | Repository reference, inclusion manifest, immutable snapshots | Model reasoning or acceptance decisions |
| Provider adapter | Launch official runtime, translate events, expose session and permission controls | Execution contract to normalized events/results | Declaring task success or changing task scope |
| Run controller | Lifecycle, ownership, budgets, dispatch, reconciliation, readiness | Task contract, capabilities, evidence | Implementing repository code |
| Verifier | Execute fixed checks and evaluate recorded acceptance requirements | Verification plan and candidate snapshot to evidence | Silently rewriting checks or acceptance criteria |
| Run store | Transactional state, event references, ownership generations | Validated transitions and evidence references | Executing repository commands |
| Memory service | Propose, review, version, retrieve, and consolidate lessons | Run evidence to proposed or approved knowledge | Updating authorization policy automatically |

Minimum records:

- `TaskContract`: task identity, repository identity, scope, non-goals, acceptance criteria, allowed changes, protected paths, provider, model selection, execution environment, and resource limits.
- `BaselineManifest`: source revision, tracked working-tree content, explicitly included untracked paths, exclusions, file modes/types, content hashes, and captured staged/unstaged status.
- `VerificationPlan`: immutable version, command registry entries, validated arguments, expected outcomes, acceptance mapping, relevant inputs, outputs permitted during checks, and required human observations.
- `RuntimeCapabilities`: exact adapter/runtime versions, platform, auth mode, tested restrictions, cancellation/resume capabilities, and qualification evidence references.
- `RunRecord`: phase, blocker, ownership generation, snapshot references, provider session reference, repair count, budgets, timestamps, and pending actions.
- `ActionRecord`: unique action identity, intent, dispatch status, observed outcome, environment, and evidence references.
- `CheckResult`: check identity, candidate/input fingerprint, command and arguments, exit or failure classification, timestamps, evidence, and freshness.
- `LessonProposal`: scope, proposed rule, applicability, supporting failure/change/check evidence, provenance, and review disposition.

Names are internal contracts, not a promise that every record becomes a public command or separate service. Keep the first release in one local application with focused modules.

## 4. Provider integration and subscription authentication

### 4.1 Common rules

The user selects a provider for the run. Resolve model and reasoning settings through that provider's documented capabilities and configured preferences. Record the actual selected values. A model catalog entry is not proof that the account can execute that model; qualification must establish a successful permitted request.

Use the runtime's existing subscription sign-in and refresh mechanisms. Ouroboros records auth mode and non-secret availability information, not access or refresh tokens. Credentials must not enter repository files, prompts, logs, snapshots, or evidence packages.

Inspect credential-source precedence before launch. An unexpected API-key environment or provider configuration must not silently change the run's billing source. Quota exhaustion and authentication expiry checkpoint the run. Version 1 does not automatically enable paid API fallback, purchase credits, or switch accounts/providers. Existing provider-side extra-usage settings must be surfaced where observable; subscription mode is not a zero-cost guarantee.

This design is for the user's local tool using their own runtimes and accounts. Distributing a product that offers provider subscription login to other people requires a separate review of the then-current provider integration requirements. Subscription usage support alone is not evidence of permission for every distribution model.

### 4.2 Codex adapter

Use the documented Codex app-server protocol over local stdio. The controller needs bidirectional events, approval handling, account state, session history/resume, and cancellation, which justify this interface over a simple batch wrapper.

- Pin the adapter contract to qualified runtime/protocol versions.
- Use managed ChatGPT authentication; let Codex retain and refresh its credentials.
- Translate provider events into controller records while retaining useful original event evidence.
- Handle approval requests through the run's explicit policy. A worker cannot grant itself additional access.
- Separate a completed provider turn from a verified candidate.
- Treat interrupt acknowledgement as the start of drainage; it does not prove all execution has stopped.

The Codex SDK remains an alternative for future simpler batch-only integrations. Remote WebSocket app-server deployment is outside this local first release.

### 4.3 Claude adapter

Use the official TypeScript Claude Agent SDK in a small trusted WSL2 adapter process. Communicate with the Windows controller over a framed, validated local stdio protocol. Use the documented streaming-input interface for typed messages, session control, permission callbacks, and hooks. This local adapter is part of the trusted controller system; the agent's repository code is not.

- Authenticate Claude Code in the selected WSL environment and use that subscription context.
- Configure the SDK environment explicitly to avoid accidental API-key precedence.
- Do not use `--bare` as a subscription-isolation shortcut: it omits OAuth authentication.
- Select the tool set explicitly and suppress unapproved repository/user settings, hooks, MCP servers, connectors, and automatic memory loading through documented controls.
- Preserve applicable managed restrictions. Disabling optional configuration loading must not override managed policy.
- Use supported pre-tool enforcement for direct file tools; `canUseTool` alone is insufficient because already-approved tools can bypass it.
- Use the WSL2 command sandbox for shell and descendant execution, with required capabilities failing closed.
- Persist session references and resume on the same qualified environment.

The implementation plan must pin and verify the exact SDK controls against its selected version. If a required tool boundary cannot be enforced through documented controls, that capability remains unavailable. Do not approximate enforcement with a prompt or silently expose the tool.

### 4.4 Capability differences

Normalize concepts, not imaginary equivalence. An adapter reports whether a capability is supported, unsupported, or not yet qualified. Examples include denied reads, network restriction, reliable process drainage, resume, quota reporting, and approval interception. Required unsupported capabilities block the run before edits.

## 5. Repository baselines and workspace ownership

### 5.1 Preserve the source

Treat the source checkout as read-only during a run. Do not stash, reset, clean, commit, update its index, or change its branch. Read the root and applicable nested repository instructions before forming the task contract. Repository content and logs are data; they cannot expand the user's authorization or weaken controller policy.

By default, capture the current tracked working-tree contents, including existing staged and unstaged changes. Record their relationship to `HEAD` and the index for provenance. Include untracked files only through the run's explicit inclusion manifest; report excluded untracked files before execution so a needed new file is not silently omitted. Ignored files, credentials, caches, dependency installations, and build outputs are not copied automatically.

If a needed prerequisite is excluded or appears sensitive, ask a focused inclusion/setup question before dependent work. Do not silently fall back to `HEAD`, and do not put secrets into an otherwise portable snapshot.

Verify that the source did not change during capture. If it did, discard the incomplete capture and request a stable baseline; do not construct a mixed snapshot. The original source may change after capture, but those later changes are not part of the run and must be reported when delivering the patch.

### 5.2 Task workspace

Create a run-owned checkout with independent writable Git metadata. Shared Git control directories from ordinary linked worktrees must not provide the worker a write path into the source checkout. An implementation can use an isolated local clone plus the captured working-tree overlay; its output must exactly match the recorded baseline before the worker starts.

For WSL2, materialize the snapshot in a Linux-native run directory and transfer results through the controller. Do not mount the original Windows checkout as the writable task workspace.

Validate paths after normalization and actual resolution. Detect absolute/traversal paths, Windows case collisions, reserved names, and symlink/junction/hardlink escapes. Preserve content and line endings. Unsupported file types, submodules, or path semantics must produce a clear preflight limitation rather than silent conversion.

Use a cross-process workspace lock and a durable ownership generation. A PID alone is not ownership evidence. Only the current owner may dispatch work, mutate run state, or publish a candidate. Reject late events from previous generations. Keep one active run per source repository in version 1.

The final patch is the difference between the captured baseline and the final candidate, not the difference from `HEAD`. Include new files and binary changes in the artifact manifest. Deliver patch and snapshot references; automatic application back into the source checkout is outside version 1.

## 6. Permissions and trusted boundaries

Keep controller state, approved policy, verification plans, authoritative evidence, and approved knowledge outside worker-writable paths. A content hash is useful for integrity checks but is not an authorization boundary if the worker can replace both content and its reference.

Command execution must use validated executable/argument structures. Do not pass a model-generated command string to a host shell as a verification command. Repository-specific commands may require a shell, but the executable, script, working directory, arguments, environment, and allowed effects must be part of the recorded plan.

The agent can propose commands inside its qualified runtime boundary. Only the controller's fixed verification registry produces authoritative verification results. A proposed new check changes the verification plan through an explicit review; it cannot replace a failed check unnoticed.

Both implementation and verification execute repository-controlled code and require boundaries. Worker shell descendants, direct file tools, trusted adapter hooks, repository hooks, MCP servers, account connectors, and verification processes must be considered separately. The built-in shell sandbox does not automatically contain every other surface.

Avoid exposing unneeded tool surfaces in version 1. Do not enable repository hooks or MCP integrations merely because a configuration file exists. Qualification must include attempts to reach controller records, source checkout paths, and provider credential locations. Canonical path checks alone are not a claimed defense against concurrent filesystem changes; unsafe surfaces must be serialized, constrained by supported runtime enforcement, or disabled.

Network policy distinguishes provider communication by the trusted runtime from network access by repository commands. Allow only the task's recorded command-network requirements. WSL Windows interoperability and native loopback access require explicit assessment; the design must not claim stronger isolation than the tested path provides.

## 7. Task lifecycle

### 7.1 Task preparation

1. Accept the scoped request and provider preference.
2. Inspect repository instructions, relevant source, existing changes, and available checks read-only.
3. Define observable acceptance criteria, allowed changes, and a verification plan before implementation.
4. Resolve only material ambiguities with the user. Routine work within the submitted task does not require repeated permission.
5. Qualify the selected environment and capture the baseline.
6. Prepare and validate the isolated workspace.

Task acceptance criteria describe behavior, not merely a list of commands. A feature request with an already-green suite still needs evidence for its new behavior. For a bug fix, reproduce the reported failure where practical and record the baseline failure; inability to reproduce must remain visible.

### 7.2 Implementation and repair

The controller supplies the task contract, relevant instructions and approved lessons, the current workspace, and evidence excerpts. The official runtime can inspect additional allowed context rather than being limited to an arbitrary first six files. Retain exact diagnostics in artifacts; use bounded excerpts with location and truncation information in model context.

After a candidate is produced, drain implementation processes, capture its identity, and begin verification. Provider self-report is advisory. Only the controller changes readiness status.

If verification fails, classify the evidence before asking for a repair. A repair must identify the supported change and affected failed checks. Preserve the failure, diagnosis, patch identity, and resulting evidence as separate records.

The user policy permits two distinct unsuccessful repair attempts. The initial candidate failure establishes the repair need; it is not itself a repair attempt. Each subsequent corrective candidate that still fails its required affected verification is an unsuccessful repair. After the second, stop in `REPAIR_LIMIT_REACHED` and return evidence. Resume does not reset this counter.

An unchanged patch, repeated failure without new evidence, or repeated unsupported action can stop earlier as `NO_PROGRESS`; repetition is not a way around the distinct-attempt limit. Authentication, quota, and infrastructure blockers do not count as code repairs, but they still obey run time/request budgets and cannot trigger endless retries.

### 7.3 State model

Store an explicit lifecycle phase and a separate blocker/reason. Normal phases are:

`CREATED -> PREPARING -> IMPLEMENTING -> VERIFYING -> READY_FOR_REVIEW`

`VERIFYING -> IMPLEMENTING` is allowed only for a supported repair within budget. Diagnosis belongs to preparation or the repair record; it does not require an independent always-on agent.

Other observable states include:

| State | Meaning and exit condition |
| --- | --- |
| `NEEDS_INPUT` | Scope, baseline, or acceptance information is missing; dependent work waits for the answer. |
| `BLOCKED` | A required runtime/environment capability is unavailable; resume requires corrective evidence. |
| `WAITING_FOR_AUTH` | Provider login needs attention; resume after runtime-managed authentication succeeds. |
| `WAITING_FOR_QUOTA` | Provider capacity is exhausted; preserve the candidate and retry only under the bounded resume policy. |
| `NEEDS_REVALIDATION` | A previously passing check became stale and the current policy does not permit silently repeating it. |
| `REPAIR_LIMIT_REACHED` | Two unsuccessful repairs occurred; return the patch and diagnostic evidence without a verified label. |
| `NO_PROGRESS` | The loop repeats without a supported advance; return the reason and evidence. |
| `RECOVERY_REQUIRED` | A prior process/action outcome is uncertain; reconcile before any new execution. |
| `DRAINING` | Stop was requested, but owned execution is not yet proven terminated. |
| `CANCELLED` | Owned execution has stopped and the final checkpoint is durable. |
| `FAILED` | A controller integrity or unrecoverable execution failure prevents continuation. |

Every run must declare finite active-execution time, per-command timeout, and artifact-output limits before dispatch. The controller enforces these observable limits independently of provider token reporting. Provider-request, token, or monetary limits may be added only where the adapter can observe and enforce them; unavailable metrics must remain explicitly unknown. Exact default values and configuration flags belong in the implementation plan.

Exhausted time, request, or output budgets produce a recorded stop reason and checkpoint. An explicitly resumed run must retain cumulative usage and declare any user-approved extension. Do not describe unavailable provider usage metrics as known spend.

### 7.4 Ready for review

The controller may mark `READY_FOR_REVIEW` only when:

- The candidate and its baseline are identified and intact.
- All required acceptance criteria have supporting evidence.
- Required checks passed and remain fresh for this candidate.
- Protected files and verification definitions were not changed without authorization.
- Any required independent review of test/fixture/configuration changes is resolved.
- No worker or verification process can still alter the candidate.
- Required evidence artifacts are present and validated.
- There is no unresolved scope, ownership, action-outcome, or capability uncertainty.

Delivery includes the incremental patch, change summary, acceptance matrix, check evidence, provider/environment identity, and unresolved external gates. A candidate can still be returned in a blocked or unverified state for inspection, but its status must make that distinction explicit.

## 8. Verification and evidence freshness

### 8.1 Plan before edits

Record the actual command definitions and acceptance mapping before implementation. A verification entry includes a stable ID, executable, arguments, directory, environment inputs, timeout, expected exit behavior, and permitted outputs. Model-generated test command text is never sufficient authority.

Existing test changes are not universally prohibited: a feature or test repair can legitimately require them. Additions and intended changes must be covered by task scope. Changes to existing assertions, skips, fixtures, package scripts, test discovery, or runner configuration require explicit integrity review. A filename or diff heuristic can detect a change requiring review; it cannot prove semantic equivalence or detect every weakened test.

Keep independent acceptance checks or expectations outside worker write authority where practical. If a requirement needs human observation, record it and wait for that evidence instead of inventing a deterministic substitute.

### 8.2 Run checks with purpose

Follow the user's verification policy:

- Select relevant checks before editing.
- Run each planned authoritative check once.
- After a supported repair, rerun only the affected failed check or checks.
- Do not repeat successful checks merely to gain confidence.
- Defer broad checks until targeted repairs have settled.
- After two unsuccessful repairs, stop with evidence.

A passing result is reusable only while its recorded inputs remain unchanged. Capture a conservative input fingerprint covering source, verification definitions, dependencies/tool versions, and relevant environment. If the adapter cannot establish a narrower safe input set, use the entire candidate input manifest.

If later edits invalidate a passing result, mark it `STALE`. Under the agreed policy, do not silently rerun it and do not reuse it as a pass. Enter `NEEDS_REVALIDATION` and identify the specific check and changed inputs. An explicit user authorization may permit that narrow revalidation. This is a correctness boundary, not permission to repeat a successful suite indefinitely.

### 8.3 Candidate freezing

Drain implementation processes before checks. Verification runs from the recorded candidate, with source inputs protected and explicitly designated writable output/cache directories. Where a tool requires writable source-adjacent paths, use a disposable verification materialization and compare the complete input manifest afterward.

Unexpected input mutation invalidates the check. Verification-generated build products do not become part of the patch without a separate authorized change. Verify that the candidate identity still matches when exporting the result.

### 8.4 Evidence handling

Record stdout/stderr, exit status, signal/timeout classification, check identity, runtime, candidate identity, and timing. Preserve diagnostically useful beginning and ending excerpts rather than assuming the final 4,000 characters contain every cause. A check with incomplete output can still have a known exit status, but missing evidence required by an acceptance criterion blocks readiness.

Apply bounded artifact sizes and explicit truncation markers. Redact credentials before durable publication; retain source/offset information for ordinary diagnostics. Redacted evidence is not described as a byte-for-byte original. Never place provider credentials in model context or export packages.

Run records distinguish assertion failures, compilation failures, policy denials, missing prerequisites, timeouts, provider errors, and controller failures. Classification models can advise, but fixed evidence and controller policy determine transitions.

## 9. Persistence, ownership, and recovery

Use SQLite for transactional lifecycle state and references, with separate content-addressed evidence files. The store lives in a user-local Ouroboros data directory outside all worker write boundaries. Public patch/report exports are separate from authoritative records.

Publish each artifact to a temporary file, complete and validate it, atomically publish it, and only then commit its reference and related state transition. A crash may leave an unreferenced artifact; it must not leave a committed reference treated as valid without the artifact. Validate references and hashes when recovering or declaring readiness. Preserve failed-run evidence; automatic destructive cleanup is outside version 1.

Record action intent durably before dispatch. Provider requests, session changes, command starts, and cancellation requests have stable action IDs. Use idempotency only where the underlying interface supports it. Do not claim exactly-once execution across a provider or process boundary.

On restart:

1. Acquire the appropriate ownership lock and inspect the prior ownership generation.
2. Reconcile owned processes, provider session status, action records, and workspace identity.
3. Mark an action `OUTCOME_UNKNOWN` if completion cannot be established.
4. Do not replay unknown actions automatically.
5. Resume only when ownership and state are established; otherwise request a narrowly described recovery decision.

For cancellation, fence new starts, request provider interruption, drain owned execution, and record the result. Prove termination through owned process/session evidence, not a provider's interrupted event alone. Never terminate unrelated user processes. An inability to establish ownership or drainage leaves the run in recovery/draining status, not `CANCELLED` or ready.

The implementation plan must select supported platform supervision mechanisms and qualification fixtures. This design requires the observable guarantees; it does not assume that Windows and WSL process controls are interchangeable.

## 10. Memory and improvement

### 10.1 Separate authority levels

| Record | Contents | Update authority |
| --- | --- | --- |
| Run evidence | Task, baseline, changes, failures, checks, and recovery facts | Controller writes automatically |
| Proposed lessons | Candidate reusable guidance linked to evidence | Consolidation can generate automatically |
| Approved project knowledge | Scoped conventions and practices for future runs | User accepts/edits/rejects proposals |
| Authorization policy | Permissions, protected paths, verification authority | Explicit user-controlled configuration; never automatic lesson promotion |

After a verified run, a bounded consolidation step may compare relevant failures with the final changes. It may return `NO_LESSON`. A failure followed by green checks is not proof that the model's explanation is correct or that the finding generalizes.

Each proposal names its scope, trigger/applicability, recommended behavior, supporting artifacts, source snapshot, and limitations. Reject duplicate, unsupported, overly broad, or tactical one-off notes. Consolidation failure does not retroactively fail a correctly verified code patch; report it separately.

### 10.2 Review and retrieval

The CLI supports accepting, editing, or rejecting proposals. Accepting a lesson creates an immutable approved version in the Ouroboros project knowledge store. Version 1 does not automatically append to `AGENTS.md`, `CLAUDE.md`, provider-global memory, or other instruction files.

Keep a concise topic index and scoped Markdown topic files. Load relevant approved topics alongside applicable repository instructions, subject to an explicit context budget. Do not treat an arbitrary 150-line threshold as a provider requirement. Proposed lessons remain excluded from future authoritative project guidance until reviewed.

When supporting code or verification assumptions change, mark the lesson for review. Prefer omitting a stale lesson to treating its authority as timeless. Consolidation creates a proposed replacement set and leaves the approved input version intact; publish a replacement only after review.

When a lesson can be enforced through a test or lint rule, propose that as a separately reviewed repository change. Promoting an explanatory lesson does not authorize installation or modification of enforcement tooling.

### 10.3 Measure usefulness

Retained context is not model training. Record task outcomes, recurrent failures, repair counts, retrieval decisions, and provider usage where available. Evaluate memory against representative held-out tasks before claiming improvement. More notes or one successful replay is not proof of better engineering performance.

## 11. Routing and Jev

Version 1 uses deterministic routing for command selection, file/skill candidate discovery, capability checks, budgets, and permissions. The user-selected provider remains fixed for the run. Use configured, documented model/effort settings rather than automatically changing models after every tool call.

Jev is an optional later adapter. Its justification must be measured improvement on labeled routing tasks, with recorded provider/model versions and calibrated thresholds. It must not be required for core subscription-backed operation.

If introduced, use the actual selected SDK's Choice, Score, and Boolean contracts; handle empty candidate sets, provider errors, missing distributions, limits, and uncertainty. Current AI SDK documentation uses `instructions`, `criteria`, and results under `answers`; the pasted `options`, `rubric`, `value`, and `distribution` access patterns must not be assumed valid.

Do arithmetic, iteration limits, date comparisons, and authorization in code. A classifier can recommend context or compute tiers; it cannot grant permissions, certify test integrity, erase evidence, authorize memory changes, or declare success. Evaluate latency and cost for the actual workload rather than assuming constant cost or a universal response time.

## 12. Qualification and acceptance

This is the acceptance structure for the later implementation plan, not authorization to run probes or build the product before that plan is reviewed.

### 12.1 Deterministic fixtures

Use simulated provider events and disposable repositories to establish:

- Validated contracts and rejection of malformed/out-of-order events.
- Legal state transitions and controller-only readiness.
- Correct WIP attribution and source-checkout preservation.
- Path containment, input mutation detection, and protected evidence handling.
- Atomic state/artifact publication and recovery from each relevant crash boundary.
- Cross-process ownership fencing and rejection of stale-generation events.
- Unknown action outcomes remaining unreplayed.
- Two failed repairs stopping; repeated no-progress candidates stopping earlier.
- Successful checks becoming stale after relevant mutations.
- Quota/auth errors pausing without automatic paid fallback.
- Lesson provenance, review disposition, version replacement, and stale retrieval exclusion.

### 12.2 Provider/platform qualification

Qualify each supported adapter/environment/version combination independently on a disposable fixture. Required demonstrations are:

| Capability | Required evidence |
| --- | --- |
| Subscription authentication | Correct runtime auth mode and successful permitted request; no unexpected API-key precedence |
| Structured lifecycle | Correlated events, session identity, completion/failure distinction |
| Permitted work | Allowed fixture edits and allowed verification commands succeed |
| Restricted work | Attempts to modify source checkout, controller records, and sibling locations are denied |
| Sensitive reads | Unpermitted credential/controller paths cannot be read through enabled worker tools |
| Command network policy | Allowed and denied fixture network cases behave as configured |
| Tool/config loading | Unapproved hooks, MCP servers, connectors, and tools do not activate |
| Cancellation | Foreground and owned descendants stop; no continuing heartbeat or unresolved execution remains |
| Crash/resume | Ownership reconciliation, preserved candidate/evidence, and no duplicate unknown action |
| Quota/auth recovery | Structured stop, preserved checkpoint, explicit bounded resume |

Test behavior, not just configuration acceptance. A successful startup or an installed WSL distribution does not qualify a sandbox. Where a provider limitation prevents a required guarantee, stop dependent implementation for that path. Repair through supported mechanisms or document the path as unavailable; do not remove the boundary to make a test pass.

Native Codex and WSL Claude are the initial required paths. WSL Codex fallback is enabled only after its own qualification. Native Claude autonomous execution remains excluded.

### 12.3 End-to-end engineering tasks

Use known fixtures with independent acceptance expectations:

1. Repair a reproducible bug, showing the initial failure and the corrected behavior.
2. Implement a small feature whose existing tests initially pass, proving that new behavior is independently checked.
3. Exercise a failed task that stops at the repair bound and returns usable evidence without a false success.

For each, verify that the delivered patch contains only task changes relative to the captured baseline, the source checkout is preserved, and the readiness label matches the evidence. Include at least one task with pre-existing WIP in the qualification set.

Run planned checks once and use targeted repair rechecks under the agreed policy. Do not repeat successful checks without a changed requirement or explicit revalidation authorization. Runtime/dependency changes invalidate the affected qualification record; a new version is a new qualification target, not evidence inherited from the old version.

### 12.4 Release evidence

The release report lists completed local acceptance cases, qualified provider/platform/version combinations, unresolved limitations, and any hosted CI results separately. This local first release has no deployment or production claim. No commit, push, release publication, or service registration occurs as a side effect of running a task.

## 13. CLI experience

The command surface should remain small. Proposed commands are:

| Command family | Purpose |
| --- | --- |
| `ouroboros doctor` | Report installed runtimes, authentication mode, environment prerequisites, and qualification status without exposing secrets |
| `ouroboros run` | Submit a scoped task with repository/provider/environment options and a repository verification profile |
| `ouroboros status` | Inspect phase, evidence, blockers, budgets, and pending decisions |
| `ouroboros cancel` | Request stop and report drainage separately from completed cancellation |
| `ouroboros resume` | Reconcile and continue a checkpointed run after its blocker is resolved |
| `ouroboros review` | Show patch, acceptance matrix, evidence links, and remaining concerns |
| `ouroboros memory` | Review proposals and approved topic versions |

Exact flags and terminal layouts belong in the implementation plan. CLI output must show actionable state in ordinary language. Keep provider/protocol details in inspectable diagnostics rather than making the user understand them to run a task.

`doctor` is informational by default. Active qualification, provider calls, or fixture mutations must be explicit operations with bounded effects and recorded evidence. Merely invoking the status/doctor commands must not consume model quota or modify target repositories.

## 14. Documentation and planning handoff

After the user approves this written spec, the implementation plan must turn it into small, verifiable tasks with exact files, dependencies, commands, and stopping conditions. Start with runtime and boundary qualification before depending on either adapter for autonomous implementation. Use least-cost suitable agents with bounded ownership, and independent review for consequential changes.

The plan must preserve the distinction between deterministic fixture coverage, live provider qualification, end-to-end task acceptance, hosted CI, and production gates. It must include the required WSL setup/auth prerequisites without performing them implicitly.

The first planning artifact should sequence one integrated local release, with optional Jev, dashboard, distribution, and broader automation explicitly deferred. It must not expand the approved task into an autonomous development platform.

## 15. Sources and verification limits

Official documentation reviewed during design on 2026-10-13:

- [Anthropic Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Claude Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Claude Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Claude Agent SDK configuration](https://code.claude.com/docs/en/agent-sdk/configuration)
- [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Claude subscription use with the Agent SDK](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Claude programmatic usage and bare-mode behavior](https://code.claude.com/docs/en/headless)
- [Claude setup and platform support](https://code.claude.com/docs/en/setup)
- [Claude sandbox boundaries](https://code.claude.com/docs/en/sandboxing)
- [Claude memory](https://code.claude.com/docs/en/memory)
- [Anthropic memory consolidation](https://platform.claude.com/docs/en/managed-agents/dreams)
- [Anthropic harness design for long-running applications](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)
- [Codex WSL support](https://learn.chatgpt.com/docs/windows/wsl)
- [AI SDK decision contracts](https://ai-sdk.dev/docs/ai-sdk-core/decisions)
- [TypeSafe model versions and limits](https://docs.typesafe.ai/models)
- [TypeSafe parallel question behavior](https://docs.typesafe.ai/cookbooks/parallel_questions)

The current workspace was empty when design began. Read-only inspection found Codex CLI 0.162.1 and Claude Code 2.1.296 on Windows, plus registered Ubuntu and Docker Desktop WSL distributions. This inventory does not establish WSL version, adapter availability inside WSL, subscription access for a chosen model, or sandbox qualification.

No product dependencies, runtime adapters, verification fixtures, or live model qualification calls have been installed or executed as part of this design. Provider documentation can change; the implementation plan must verify the pinned versions and relevant contracts before relying on them.
