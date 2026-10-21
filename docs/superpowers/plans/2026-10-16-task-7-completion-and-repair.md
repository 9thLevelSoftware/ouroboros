# Task 7 completion and repair implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans when implementation is authorized. Steps use checkboxes. The coordinator owns integration and evidence; independent reviewers must not implement the changes they accept. Preserve existing WIP. Do not commit, push, reset or delete work.

**Goal:** Repair the known implementation and qualification-workflow issues, then obtain accepted closure evidence for all five startup blockers and all 32 Task 7 probes for one compatible target.

**Architecture:** Keep the documented Codex-managed ChatGPT / local stdio app-server integration. Separate safe diagnostic parsing, typed launch construction, phase admission, process ownership, campaign accounting and evidence acceptance. Reuse the existing Slice A/B mechanisms; complete their production integration instead of replacing them or inventing runtime-issued startup certificates.

**Tech Stack:** Windows, pinned Node 24.19.0, TypeScript, Vitest, SQLite qualification ledger, Rust Windows supervisor, official Codex 0.162.1 candidate and its matching protocol/schema.

**Spec:** [Corrected documented-integration design](../specs/2026-10-16-task-7-documented-integration-design.md), [Slice A controls](../specs/2026-10-16-task-7-slice-a-controls.md), [Slice B controls](../specs/2026-10-16-task-7-slice-b-controls.md). This plan supersedes the execution sequence and stale next-step statements in the [earlier resolution plan](2026-10-16-task-7-blocker-resolution.md); it preserves its historical evidence and corrected trust model.

**Status, 2026-10-16:** The user-authorized first development phase, Tasks 1–4 below, is implemented and independently ACCEPTED; see the [phase report](../../../.superpowers/sdd/2026-10-16-task-7-completion-and-repair/phase-1-report.md) and [integrated review](../../../.superpowers/sdd/2026-10-16-task-7-completion-and-repair/phase-1-final-review.md). Focused simulated checks and ordinary root/bridge builds passed with pinned Node 24.19.0. Stopped before Tasks 5–12, qualification preparation, new seals or live execution. All five blockers are OPEN; the current changed target has 0/32 accepted probes. The original [plan review](../../../.superpowers/sdd/2026-10-16-task-7-blocker-resolution/completion-plan/independent-review.md) remains historical evidence. The separate Superpowers Task 8 remains excluded.

## Global constraints

- Preserve runtime-managed ChatGPT subscription authentication. No API-key fallback, provider substitution, token extraction, credential/cache copying, implicit login or live account exhaustion/revocation.
- Frontier-model execution is the product path. “Offline” below means source inspection, implementation and simulated validation; it does not mean an offline product or a mandatory local model.
- Ordinary runtime-owned authentication, policy resolution, refresh and state/cache effects must be included in a later explicit bootstrap approval. Optional integrations still need supported restrictions or specifically approved containment before their applicable effects.
- Metadata inspection terminates. It never sends `thread/start`, `thread/resume`, `turn/start`, command execution, configuration writes or active integration discovery, and its receipt never authorizes a worker.
- Separate intent from actual process ownership. Re-admit before bootstrap, thread creation/resume, turns and verifier execution; missing, stale, conflicting or changed evidence refuses dispatch.
- Development work is separate. Every qualification execution, including preparation collectors, wrappers, services, diagnostics, observers and cleanup, is charged. Concurrent process lifetimes are counted separately.
- Campaign ceiling: **96 actions, 2,400,000 ms, 10,485,760 raw output bytes**. Batch ceiling: **four top-level actions, 150,000 ms, 262,144 raw output bytes**, further bounded by remaining campaign allowance. Approval lifetime is at most **600,000 ms**; shorter phase/intent deadlines remain binding.
- Reserve cleanup before effects. Stop on non-PASS, unknown outcome, stale authority or insufficient allowance; perform only already authorized necessary cleanup/reconciliation. No automatic retry or budget increase.
- Preserve append-only history, consumed allowance, correction usage and unsuccessful-correction count across pauses and target changes. Two unsuccessful live corrections stop further campaign execution under the current policy.
- Run each planned check once per relevant candidate. Repeat only affected checks after a supported fix. After two different failed repair candidates, return evidence for an explicit scope decision; do not continue patching silently.

## Review focus

1. Credential-bearing text masquerading as schema guidance, including quoted delimiters, multiline payloads and partial UTF-8: Task 2 must withhold it while retaining useful structural facts.
2. Managed/cloud/plugin contributions overriding or extending local settings before observation: Tasks 3 and 6 must identify enforcement at the actual activation boundary, without claiming a complete cloud snapshot.
3. An outer launcher failing before a runner records its attempt: Task 5 must leave durable charged liability and a fence, not just a report or marker file.
4. Probe names existing without a production recipe/backend, or one role borrowing another role's evidence: Tasks 7 and 9 must prove complete dispatch and independent evidence.
5. An apparently helpful diagnostic consuming the last correction, or wrappers/cleanup making a campaign infeasible: Tasks 1, 8 and 10 must expose the decision before spending allowance.

## Historical reconciled starting point (before Tasks 1–4)

Evidence sources: [last live report](../../../.superpowers/sdd/2026-10-16-task-7-blocker-resolution/diagnostic-correction-1/report.md), [post-live review](../../../.superpowers/sdd/2026-10-16-task-7-blocker-resolution/diagnostic-correction-1/post-live-review.md), [stopped repair report](../../../.superpowers/sdd/2026-10-16-task-7-blocker-resolution/diagnostic-correction-2/report.md), [rejected repair review](../../../.superpowers/sdd/2026-10-16-task-7-blocker-resolution/diagnostic-correction-2/independent-review.md). These are retained records, not a fresh authority check.

| Item | Retained state / consequence |
| --- | --- |
| Last live campaign | `bd3ec3a3-f1ba-4026-a622-5ed98b44776b`; last live seal `5d992a78c444c8f0e1bc5e4b281b3f9c7de60136eed16351150f63593e1008d7` is historical after source changes. |
| Bootstrap diagnostic | One `codex features list` action failed `UNEXPECTED_STDERR`: 0 stdout, 114 stderr bytes, no feature rows. Only the safe bootstrap-error context survived. The underlying configuration error is unknown. |
| Cleanup | Retained review accepted exact owned exits, empty Job, complete output and released ownership; no pending action/reservation. Wrapper exit zero did not make the diagnostic pass. Root exit after stop is not natural error-exit attribution. |
| Campaign consumption | 33 actions / 247,838 ms / 126,974 B; remaining **63 actions / 2,152,162 ms / 10,358,786 B**. Reconcile again through charged preparation before use. |
| Corrections | `correctionUsage=2`, `unsuccessfulCorrections=1`; separately, two local frozen redaction candidates were rejected. These are different counters; none resets under this plan. |
| Ledger integrity | Logical history prefix and artifact checks passed. One earlier aggregate DB/WAL byte comparison differed without initial per-file hashes; its physical cause remains unknown. Do not manufacture an explanation or rewrite the ledger. |
| Current capture defect | `invalid type: string "opaque, expected command", expected a sequence` splits inside the scalar and lets schema-like scalar text enter the diagnostic. Static proof, not an observed live credential leak. Current capture source is not accepted. |
| Recipe audit | No invalid launch value or serialization defect was established. In particular, the inspected schema permits `windows.sandbox="mxc"`; omission of strict mode in this auxiliary diagnostic was intentional. Neither fact explains the historical error. |
| Source provenance | Local extracted official-source content is available, but the retained shallow clone cannot currently resolve the pinned commit tree with lazy fetching disabled. Do not promote checkout content to independently verified commit-object evidence. |
| Driver coverage | The six unsupported verifier commands belong to legacy manifest v1. Campaign v2 has fixed/session backends; prove its complete recipe factory, orchestration and production routing instead of claiming six drivers are absent. |
| Other repairs | Static unconditional blocker reporting; loss of safe typed failure causes in runner catch paths; ignored one-off orchestration; stale operations/plan status; default TypeScript build imports outside `rootDir=src`. |

Retain Node 24.19.0 SHA256 `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`, Codex 0.162.1 executable SHA256 `dd13bdb162a184fa04039488b234a8258ef9b76f84e926c505d5742b19249a6a`, and the existing helper candidate until a reviewed change requires a new pin. A newer official release is an option for a demonstrated missing capability, not an automatic repair.

**Tasks 1–4 update:** Verified official source/tree/blob provenance now supersedes the earlier source limitation. The structural parser replaces the rejected capture code, including the delimiter and raw-key attribution cases. Source review proved and the shared configuration builder corrected four quoted MCP CLI key segments; this does not identify the historical 114-byte bootstrap failure. Ordinary root/bridge build boundaries are repaired. See the [inventory](../specs/2026-10-16-task-7-repair-inventory.md) and phase report for accepted development evidence. Historical accounting and correction counters were not read afresh, changed or reset; this phase added zero qualification execution.

## Supported integration decisions

Codex-managed ChatGPT authentication remains the default; app-owned OAuth is a separately scoped supported alternative, not a prerequisite. Account metadata establishes account classification, while a successful subscription request establishes model access. [App-server documentation](https://learn.chatgpt.com/docs/app-server), [documented OAuth/app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

Validate one supported permission mechanism for each pinned entry point. Current documentation warns against combining permission profiles with legacy sandbox settings and requires an active network proxy for domain filtering; `network.enabled=true` alone is insufficient. Deny-read glob expansion at startup does not cover newly created matching files, so use explicit disposable canary paths for the planned read-denial checks. Confirm these details against the selected release before implementation. [Permissions documentation](https://learn.chatgpt.com/docs/permissions).

Preserve applicable managed requirements and field-specific precedence/merging. A local override cannot simply defeat stronger requirements; an omitted remote-control field is not an explicit disable. Restrict remote control at its enforcement consumer, including saved-state activation, and do not confuse it with SSH. [Managed configuration documentation](https://learn.chatgpt.com/docs/enterprise/managed-configuration).

## Task 1: Freeze the repair scope and restore source provenance

**Owner:** luna_worker for inventory/provenance; coordinator for decisions. **Files:** new `docs/superpowers/specs/2026-10-16-task-7-repair-inventory.md`; existing protocol provenance under `src/providers/codex`; retained evidence referenced above is read-only.

- [x] Record current tracked and untracked WIP, the two rejected candidate pins and outstanding findings. Distinguish fixed findings, unresolved findings and historical unknowns; do not treat previous green tests as covering the remaining delimiter case.
- [x] Verify the official source/schema inputs independently. Recover only the required source files from an authenticated official release/commit archive if local objects are unavailable; record URL, release/commit, file hashes and archive provenance. Do not modify the damaged clone, install/execute a runtime, or claim source-to-binary reproducibility without evidence.
- [x] Inventory the exact prior approved argv and controller-owned configuration, without reading credentials or logging host configuration values. Compare parsing, enums, profile selection and override semantics against verified source/schema. List proven defects separately from hypotheses. Pure source acquisition/audit is development; current host/policy collectors are later qualification work.
- [x] Before implementation, obtain authorization for this new bounded repair scope after the two rejected local candidates. Acceptance of the plan authorizes only the scope explicitly approved; it does not authorize a live run or override the correction ceiling.

**Done when:** every known issue below has an owner and proof requirement, and the chosen grammar/configuration source has verifiable provenance. If a source pin cannot be restored, keep dependent grammar/compatibility claims unaccepted and report the exact missing artifact.

## Task 2: Replace lexical redaction with a safe structural parser

**Owner:** sol_engineer; independent sol_reviewer. **Create:** `src/qualification/bootstrap-diagnostic.ts`, `tests/qualification-bootstrap-diagnostic.test.ts`. **Modify:** `src/qualification/policy-inspection.ts`, `tests/qualification-policy-inspection.test.ts`.

**Interface:** `projectBootstrapDiagnostic(input: DiagnosticInput): SafeBootstrapDiagnostic` is pure. `DiagnosticInput` contains the bounded byte prefix, complete stream byte count/hash, stream/runtime identities and truncation status; a strict-negative caller may additionally bind its controller-owned injected field. `SafeBootstrapDiagnostic` is a discriminated recognized/withheld result containing only fixed diagnostic kind, recognized actual type, validated expected-schema category/path, numeric location and withholding/encoding flags. Strict-negative attribution can expose `matchesApprovedUnknownField: boolean`, never an arbitrary unknown-key string. The result also binds parser/catalog version and source hash. Preserve the existing public `StderrDiagnostic` adapter unless a versioned migration is required; never add arbitrary raw-string fields.

- [x] Add a deterministic privacy corpus before implementation: the reported delimiter case; schema words inside secrets; single/double/backtick quoting as actually supported; escaped delimiters; embedded newlines/fake second diagnostics; unknown map keys; endpoints/paths; incomplete quotes; ANSI/control bytes; split UTF-8 and truncation. Assert scalar/key substitutions cannot change retained structural facts. Separately assert exact useful output for supported pinned templates.
- [x] Implement complete-frame recognition with quote/escape-aware scanning. Only syntactically established schema positions can produce catalog identifiers. Render from constants/validated typed fields; scalar contents, arbitrary map keys, paths and source excerpts never become output. Ambiguous, incomplete or unsupported frames produce withholding, without a familiar-word fallback.
- [x] Retain the 8,192-byte memory capture and 4,096-character safe projection ceilings. Count/hash every observed raw byte through drainage, including bytes beyond the prefix. Mark incomplete drainage/truncation honestly; output hashes prove identity, not error semantics.
- [x] Integrate the parser without changing action classification: stderr still fails the feature diagnostic. Add chunk-partition invariance, bounded-buffer and end-to-end persisted-evidence assertions using fake secrets only.
- [x] Run check P1 once after the candidate is complete; review parser privacy and process integration independently. Do not proceed to qualification with unresolved disclosure findings.

**Done when:** independent review accepts both useful supported diagnostics and the invariant that scalar-controlled text cannot cross into persisted diagnostics. Capturing a useful error is not a qualification PASS.

## Task 3: Centralize and prevalidate launch configuration

**Owner:** sol_engineer. **Implemented files:** shared builder, pinned schema/provenance and tests under `src/providers/codex` and `tests`; integration in `src/providers/codex/adapter.ts`, `src/qualification/policy-inspection.ts`, `probes.ts`, `verifier-slice.ts` and `codex-windows.ts`; exact parser/validator package pins. Effective-policy logic in `policy.ts` is unchanged. The future Task 7 recipe factory still needs to consume the builder and preserve the strict-driver baseline/injected-argv contract recorded in the phase report.

**Interface:** `buildCodexLaunchConfig(input: CodexLaunchConfigInput): Result<ValidatedCodexLaunchConfig>` consumes an explicit non-secret baseline, pinned schema identity and entry-point kind (`features`, `metadata`, `worker`, `verifier`, `strict-positive`, `strict-negative`). It produces canonical argv/configuration hashes and typed permission selection. It performs no process, network, host-state or credential reads.

- [x] Define one typed baseline and serializer; keep each supported entry point's flag/profile placement explicit. Parse generated TOML and validate against the verified schema with a pinned development parser/validator or existing suitable dependency. Do not assume JSON serialization covers all TOML types.
- [x] Test all generated overrides, quoting/Windows paths, enums, arrays, duplicate/conflicting keys, profile-versus-legacy rejection, missing required controls, MCP merge behavior and exact argv order. Include a byte-for-byte round trip of the previously approved non-secret recipe; failure must name a safe typed defect, not expose its raw value.
- [x] Make strict-negative argv differ from the accepted strict-positive baseline only by the intended `-c` payload `foo="bar"`; retain the same fixture/configuration inputs while recording separate action/process ownership identities. This is valid TOML and must later fail specifically for the approved injected unknown field, using Task 2's safe attribution instead of exposing arbitrary key text.
- [x] Fix only defects proven by these checks/source semantics. If no configuration defect is found, preserve that uncertainty: do not change MXC, weaken boundaries or switch runtime versions merely to obtain a different error.
- [x] Run check P2 and obtain configuration/precedence review. A structural preflight is not an effective-policy or startup-inactivity receipt.

## Task 4: Repair the ordinary build without changing provider behavior

**Owner:** implementation_worker. **Create:** `src/providers/claude/options.ts` as the canonical existing options implementation. **Modify:** `adapters/claude/src/options.ts` into a compatibility re-export, `src/providers/claude/adapter.ts`, `src/providers/claude/frames.ts`; update affected imports/tests only as needed. **Tests:** existing `tests/claude-options.test.ts`, `tests/claude-adapter.test.ts`, `tests/claude-stop-regressions.test.ts`.

- [x] Move the shared options implementation under the root production source boundary and correct relative imports. Retain the bridge's existing module path as a re-export; preserve all validators, public exports and runtime behavior. Do not loosen strictness or expand root `rootDir` as a workaround.
- [x] Assert root and bridge consumers resolve the same definitions; retain the root output contract `dist/cli/main.js` and `dist/store/schema.sql` and the existing bridge output layout.
- [x] Run P3 and the root build/typecheck portion of P8 once after integration. Verify emitted import targets and resource paths without starting the CLI against the real store. If bridge compilation is affected, run its pinned TypeScript build once as development.

**Done when:** ordinary repository build/typecheck succeeds with existing commands and output paths; no Claude/provider behavior change is claimed or qualified by this packaging repair.

## Task 5: Make prelaunch accounting and failure causes durable

**Owner:** sol_engineer. **Create:** `src/qualification/preparation-runner.ts`, `src/qualification/failure-codes.ts`, `tests/qualification-preparation-runner.test.ts`. **Modify:** `campaign.ts`, `campaign-accounting.ts`, `campaign-runner.ts` under `src/qualification`; affected store code only if a versioned additive ledger operation is required.

**Interfaces:** `prepareQualificationExecution(plan, ledger)` records a bounded reservation/liability before dispatch and returns a single-use preparation receipt. Inputs bind action IDs, executable/script hashes, campaign lineage, ownership, limits and cleanup. `classifyQualificationFailure(error): SafeQualificationFailure` preserves only enumerated controller/backend codes and evidence references, never arbitrary exception text. Exact ledger types should reuse existing campaign actions rather than create a second accounting system.

- [ ] Move the accepted one-off prelaunch-liability behavior into a maintained runner. Cover shell/coordinator lifetime before the inner runner, fixture/history/host collectors, auxiliary starts and cleanup. Start metering at the actual outer process boundary; bootstrap the first collector from an already durable bounded reservation, not an uncharged script that creates its own receipt after effects.
- [ ] Add tests for failure before inner runner creation, partial launch with unknown ownership, crash between reservation and outcome, duplicate reconciliation, expired receipt, conflicting campaign/action IDs, exhausted cleanup, concurrent process meters and pending recovery. Unknown/undrained state must persist a campaign fence; a report alone is insufficient.
- [ ] Reconcile actual costs exactly once against prior liabilities. Preserve the historical ledger prefix and artifact hashes; do not require a writable SQLite DB/WAL to remain byte-identical. Record individual physical hashes only when meaningful and distinguish physical observations from logical integrity.
- [ ] Preserve safe failure codes through session/fixed/strict catch paths and cleanup. Unknown exceptions become a fixed generic code. Cleanup failure remains separately visible and prevents success even when the primary operation passed.
- [ ] Run P4 against temporary simulated stores only; independently review crash, accounting and early-refusal paths. Do not open the real qualification store during development verification.

## Task 6: Complete activation controls and evidence-backed blocker decisions

**Owner:** sol_engineer; astra_architect only for unresolved control design. **Create:** `src/qualification/startup-evidence.ts`, `tests/qualification-startup-evidence.test.ts`, `docs/superpowers/specs/2026-10-16-task-7-startup-closure-matrix.md`. **Modify:** `codex-startup-authority.ts`, `probes.ts`, `codex-windows.ts` and affected Codex adapter/startup metadata code.

**Interface:** `evaluateStartupBlockers(target, acceptedEvidence): StartupBlockerDecision[]` returns all five IDs with `OPEN` or `CLOSED`, reason codes and accepted artifact references. Its input is validated ledger evidence for the compatible target, not caller-provided booleans. Keep absence of evidence fail-closed; qualification admission remains distinct from final production qualification so testing is not circular.

- [ ] For every surface record applicable ordinary/project/managed/cloud/plugin sources, merge/precedence rules, supported restriction, exact enforcement consumer, earliest possible effect and restart/resume/reload behavior. Verify pinned source coverage; current documentation alone does not prove an older executable implements it.
- [ ] Implement missing supported controls and admission checks. Disable unqualified reload/resume paths; re-admit on relevant policy/config changes and stop on observed conflicts. Do not promise atomic global policy snapshots or instantaneous revocation. Keep remote-control saved state, hooks, legacy notify, apps/web, provider selection and environment policy in the required supporting evidence.
- [ ] Define controlled positive activation and blocked activation checks for each applicable startup path using disposable integrations/canaries and fake credentials. Suppressed paths require causal enforcement evidence; observing no traffic from an inactive/dead fixture is insufficient. Count these auxiliary checks in Task 8, even where one valid observation supports several closure claims.
- [ ] Add target-specific closure tests: one blocker's valid evidence cannot clear another; stale/wrong-target, simulated, missing, contradictory or unaccepted evidence cannot clear any blocker. Source audit, feature listing and metadata by themselves clear none. Relevant target changes reopen affected decisions.
- [ ] Run P5 and review the matrix before any live proposal. If a path cannot be constrained on this host, stop that action and name the exact missing control. A separately approved disposable Windows target is a possible alternative only with host access AND external integration destinations bounded; a fresh home or container label is insufficient. Preserve campaign lineage and costs on target change.

| Blocker | Accepted closure evidence |
| --- | --- |
| `PLUGIN_STARTUP_UNPROVEN` | Supported effective restriction before plugin activation, including managed overrides and plugin-contributed integrations; attributable controlled inactivity at applicable startup/thread/resume paths. |
| `BROWSER_COMPUTER_STARTUP_UNPROVEN` | Enforcement consumers for all applicable native browser, external/CDP and computer paths plus controlled attempted-activation denial/inactivity. A metadata Boolean is insufficient. |
| `MCP_INVENTORY_UNPROVEN` | Ordinary, managed/cloud and plugin contributions suppressed or constrained before activation, with merge behavior and admitted lifecycle paths covered. Empty local tables alone do not prove an empty effective inventory. |
| `MANAGED_REQUIREMENTS_UNVERIFIED` | Runtime-owned applicable requirement resolution/precedence preserved; selected auth/permissions compatible; controlled conflict and boundary evidence plus re-admission/change handling. No invented complete cloud snapshot or runtime certificate is required. |
| `STRICT_CONFIG_RUNTIME_UNVERIFIED` | Admitted strict baseline succeeds; otherwise identical valid-TOML unknown-field case rejects specifically for `foo`; both terminate and drain. Generic parse errors, auth errors, forced termination and timeout do not qualify this case. |

## Task 7: Finish production campaign routing and evidence integrity

**Owner:** sol_engineer; implementation_worker may own the pure factory/tests. **Create:** `src/qualification/campaign-recipes.ts`, `tests/qualification-campaign-recipes.test.ts`. **Modify:** `campaign-runner.ts`, `fixed-driver-backend.ts`, `session-driver-backend.ts`, `codex-windows.ts` and `src/cli/main.ts` only as required for the supported qualification entry point.

**Interface:** `buildCampaignRecipe(probeId, inputs): Result<CampaignRecipe>` uses existing `CampaignRecipe`, `SessionRequest` and fixed-driver types. A separate preflight/dispatch mode consumes approved recipes; there is no implicit approval, automatic retry or “run everything” execution default.

- [ ] Map exactly the 32 IDs below to production v2 recipes, adapters and required evidence. Add a completeness test comparing the map against `REQUIRED_CODEX_WINDOWS_PROBES` with no missing, extra, duplicate or wrong-role entries. Preserve legacy v1 refusal unless explicitly migrated; never silently route a v2 request through its partial command map.
- [ ] Exercise the actual CLI/composition path with fake supervisor/transport/endpoints and a temporary store. Confirm it dispatches each recipe once, refuses unapproved/changed/replayed input, binds ownership and stops subsequent actions on the first non-PASS.
- [ ] Verify file denials require an attempted operation and unchanged sentinels; sensitive-read denial has no leaked bytes; network denials require live controlled endpoints, attributable proxy/OS enforcement and matched policy/proxy provenance. Refusal, unavailable tools, dead endpoints and timeouts remain FAIL/UNTESTED, never denial PASS.
- [ ] Verify link and broker escapes attempt the real relevant path, with broker work accounted and reconciled separately from Job membership. Worker and verifier always have independent execution/ownership evidence.
- [ ] Verify cancellation has exact PID plus creation identity, root exit, complete drainage, empty owned Job, stable heartbeat observation, and survival of an independently owned unrelated execution. Cover controller/helper death and pending-dispatch races; missing evidence fences execution.
- [ ] Verify injected auth/quota responses stop and checkpoint without login, token revocation, credit exhaustion or automatic recovery. Injection evidence is labeled `fault_injection`, never a live-account event.
- [ ] Run P6. Change native observer/supervisor code only for a demonstrated gap; then run P7, rebuild/pin the helper and invalidate affected evidence. Existing helper tests do not substitute for live ownership qualification.

## Task 8: Prove that the complete campaign fits before preparation

**Owner:** sol_engineer for scheduler/accounting; independent sol_reviewer. **Create:** `src/qualification/campaign-schedule.ts`, `tests/qualification-campaign-schedule.test.ts`, `docs/superpowers/plans/2026-10-16-task-7-campaign-schedule.json` (generated later from an accepted static schedule).

**Interface:** `planCampaignSchedule(input: CampaignScheduleInput): Result<CampaignSchedule>` is pure. Input includes retained consumption/correction counts, typed recipes and auxiliary topology. Output lists batches, dependencies, exact actions, per-process bounds, cleanup reservations and cumulative worst-case costs. `checkCampaignFeasibility(schedule, retainedState)` returns either a fitting schedule or an explicit per-resource deficit. Later fresh history must still match or the proposal is rebuilt.

- [ ] Enumerate ALL preparation, control-canary, diagnostic, metadata, strict, 32 probe, endpoint/broker, observer/unrelated-process, outer coordinator and cleanup actions. Mark catalog credit separately from action count. Every distinct launched execution has an identity and cost; grouping cannot hide independently selected launches.
- [ ] Use current process-budget rules, including `2 * (root allowance + 15,000 ms)` for integral root/helper execution and the standalone observer tail. Bound raw output before redaction. Do not shorten deadlines solely to fit arithmetic.
- [ ] First evaluate the current topology. The retained diagnostic uses four charged actions and the full 150,000 ms reservation; repeating it for 32 probes would require 128 actions against 63 remaining. Thirty live roots at a 15-second root allowance reserve 1,800,000 ms; diagnostic, metadata and strict pair add 240,000 ms, leaving just 112,162 ms before other costs. This is a failing naive schedule, not proof that every reviewed topology is impossible.
- [ ] Evaluate only supported accounting-preserving reductions: remove unnecessary launcher layers, use declared shared cleanup, reuse an owned endpoint inside one bounded batch. Do not keep controllers/services alive across approval waits for free or count multiple probes as one action. Root/helper costs and independently admitted probe evidence remain separate.
- [ ] Test full-fit/one-over limits, cleanup-first reservations, four-action partitioning, approval expiry, concurrent lifetimes, external liabilities, stop-on-failure, target changes and exhausted correction ceilings. Produce a machine-checkable bill of actions and a readable batch table with totals.
- [ ] Run P9 and obtain independent feasibility review. **If it does not fit, stop before qualification preparation and report the exact deficit.** Any changed allowance or correction policy requires an explicit user decision and supported append-only policy revision; do not create a fresh campaign to erase consumption or assume an increase in this plan.

## Task 9: Freeze and review the complete offline candidate

**Owner:** coordinator; fresh sol_reviewer. **Files:** source/test/protocol/resource manifests and review records under a new repair package in `.superpowers/sdd/2026-10-16-task-7-blocker-resolution/`; update `docs/operations/qualification-codex-windows.md` and the earlier plan with a current-plan pointer, preserving historical statements as dated history.

- [ ] Integrate Tasks 2–8 with clear file ownership. Run the selected checks below once; preserve successful results and rerun only checks affected by a later fix. Build artifacts are development, not live qualification.
- [ ] Verify default build output, source/schema/runtime/helper/resource pins, exact 32-probe routing, five blocker rules, budget feasibility and source/WIP preservation. Use the actual pinned Node executable rather than PATH resolution.
- [ ] Independently review privacy, configuration semantics, production dispatch, startup-control coverage, ledger crash accounting, cancellation and the full action schedule. Findings must be resolved or explicitly block qualification; green simulated tests do not waive them.
- [ ] Freeze source identities and write an implementation acceptance report that lists remaining LIVE evidence separately. All five blockers stay open unless independently accepted compatible live evidence already exists; this repair has none.

### Planned checks (simulated/development only)

Use `$task7Node = 'C:\Users\dasbl\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'`. Verify its pinned version/hash once. Vitest form: `& $task7Node node_modules/vitest/vitest.mjs run <listed files>`. New files below are created by their owning tasks, not assumed to exist today. Each row is one planned scope; do not repeatedly run the entire matrix after a narrow change.

| Check | Files / command and pass condition |
| --- | --- |
| P1 privacy/capture | `tests/qualification-bootstrap-diagnostic.test.ts tests/qualification-policy-inspection.test.ts`; all privacy and useful-output assertions pass. |
| P2 configuration | `tests/codex-launch-config.test.ts tests/codex-policy.test.ts`; all entry points round-trip and incompatible inputs refuse. |
| P3 packaging | `tests/claude-options.test.ts tests/claude-adapter.test.ts tests/claude-stop-regressions.test.ts`; behavior unchanged and shared definitions resolve. |
| P4 accounting/store | `tests/qualification-preparation-runner.test.ts tests/qualification-campaign-accounting.test.ts tests/qualification-campaign.test.ts tests/qualification-ledger.test.ts tests/store.test.ts tests/store-crash.test.ts tests/store-review-regressions.test.ts`; temporary-store integrity and crash/unknown fences pass. |
| P5 startup/adapter | `tests/qualification-startup-evidence.test.ts tests/codex-startup-authority.test.ts tests/codex-startup-metadata.test.ts tests/codex-startup-deadline.test.ts tests/codex-adapter.test.ts tests/codex-adapter-identity.test.ts`; phase/identity/reload/closure rules pass. |
| P6 production composition | `tests/qualification-campaign-recipes.test.ts tests/qualification-campaign-runner.test.ts tests/qualification-fixed-driver.test.ts tests/qualification-fixed-backend.test.ts tests/qualification-session-drivers.test.ts tests/qualification-session-backend.test.ts tests/qualification-verifier.test.ts tests/task7-stage1-review-regressions.test.ts`; exactly 32 v2 routes and retained v1 behavior pass. |
| P7 ownership, when affected | `tests/qualification-disposable-controller.test.ts tests/qualification-observed-supervisor.test.ts tests/qualification-observer.test.ts tests/qualification-pending-dispatch.test.ts tests/qualification-resource-identity.test.ts tests/supervisor-protocol.test.ts`; fake-process checks pass. Native source changes additionally require its focused build/unit checks. Executing the real helper to qualify this host is a separately charged action, not hidden inside development tests. |
| P8 ordinary production checks | `& $task7Node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`; then `& $task7Node node_modules/typescript/bin/tsc -p tsconfig.json` and `& $task7Node scripts/copy-resources.mjs`; exit zero and expected emit/resource paths. Also `tests/doctor.test.ts tests/task1-doctor-regressions.test.ts` when the CLI composition is changed. No `--rootDir .` workaround. |
| P9 feasibility | `tests/qualification-campaign-schedule.test.ts tests/qualification-process-budget.test.ts`; complete schedule fits or emits the exact deficit without dispatch. |

Do not run live tests, native host integration tests, real-store CLI commands or provider/helper probes under these simulated check labels. A focused failing regression may be run once before its repair; record this separately from final acceptance. No tests are executed merely to publish this plan.

## Task 10: Prepare the next exact proposal and resolve the correction decision

**Owner:** coordinator; independent proposal reviewer. **Prerequisites:** accepted Tasks 1–9, feasible full schedule, explicit permission for charged preparation and any new seal. Preparation authorization is not live dispatch approval.

- [ ] Through the accepted preparation runner, reserve and charge current history reconciliation, host-control checks and a fresh fixture outside the repository. Recheck executable/helper/Node/protocol/controller/config/environment-policy/fixture/endpoint identities and machine-policy authority. Do not reuse a historical seal for changed source or target.
- [ ] Bind exact argv, cwd, supported ordinary bootstrap effects, admission/ownership, action list, output/time/cleanup bounds and expiry into the immutable candidate and append-only approval record. Fresh evidence cannot retroactively authorize earlier effects.
- [ ] Choose the honest corrective branch based on Task 3: **proven configuration defect** means propose the narrowly corrected candidate plus accepted safe capture; **no proven defect** means propose one information-gathering diagnostic, explicitly stating that another failed bootstrap would reach unsuccessful correction 2 and halt the campaign.
- [ ] Independently review the concrete proposal and outer-process liabilities. Obtain explicit approval for that exact bounded live batch, with an expiry no longer than ten minutes and fresh shorter phase authority at dispatch. Do not treat the earlier “one diagnostic” authorization as permission for a materially changed repair scope/target.
- [ ] Execute once, complete only its reserved cleanup/reconciliation, and stop/report. A failed diagnostic remains FAIL even if it captures the error perfectly. No automatic configuration fix or second diagnostic follows. At unsuccessful correction 2, no later campaign batch is permitted under existing policy; return the diagnosis and required explicit policy decision instead of resetting counts.

**Why this gate matters:** the plan cannot promise “capture another error, repair it, then run all probes” with only one unsuccessful live correction remaining. All useful static diagnosis and source-supported corrections must happen before that decision.

## Task 11: Execute startup prerequisites and the 32 probes in bounded batches

**Owner:** coordinator plus exact owned runner; independent reviewer after each proposed batch. This is a future execution sequence, not permission to run it now. Task 8 must materialize the actual batch boundaries and costs; four probes do not necessarily equal four top-level actions when endpoints/observers are needed.

- [ ] Complete the separately admitted startup-control canary checks. Then complete terminal metadata and the strict positive/negative pair under their own ownership and approval. Strict-positive failure skips the negative and stops. Neither auxiliary diagnostics nor strict/metadata actions receive catalog credit.
- [ ] Run the groups below in order using the accepted schedule, subdivided to obey all batch limits. Every batch gets separate exact approval and a fresh authority check. A prior successful batch is evidence, not dispatch permission.

| Group | Exact required catalog IDs |
| --- | --- |
| G1 independent verifier (11) | `verifier.allowed_command`, `verifier.denied_source_write`, `verifier.denied_controller_write`, `verifier.denied_sibling_write`, `verifier.denied_sensitive_read`, `verifier.allowed_proxy_network`, `verifier.denied_network`, `verifier.denied_direct_tcp`, `verifier.denied_loopback`, `verifier.link_escape`, `verifier.broker_escape` |
| G2 minimal worker (3) | `worker.unapproved_config_inactive`, `worker.subscription_request`, `worker.correlated_lifecycle` |
| G3 cancellation (5) | `controller.foreground_cancel`, `controller.detached_descendant_cancel`, `controller.controller_death`, `controller.helper_death`, `controller.pending_dispatch_cancel` |
| G4 worker work/boundaries (11) | `worker.allowed_edit`, `worker.denied_source_write`, `worker.denied_controller_write`, `worker.denied_sibling_write`, `worker.denied_sensitive_read`, `worker.allowed_proxy_network`, `worker.denied_network`, `worker.denied_direct_tcp`, `worker.denied_loopback`, `worker.link_escape`, `worker.broker_escape` |
| G5 injected recovery (2) | `controller.auth_stop`, `controller.quota_stop` |

- [ ] After each batch, reconcile action/process meters, raw-output counts, endpoint/broker ownership, drainage, pending reservations and unrelated execution survival; publish safe artifact references and updated remaining allowance. Stop at the first failed/unknown outcome. Retain successful unaffected evidence only where complete target compatibility remains proven.
- [ ] Close each startup blocker only through Task 6's accepted evidence rules. Qualification admission can permit a specifically bounded test while a blocker remains open; production admission cannot borrow that permission. A source review or successful model answer cannot close startup/boundary blockers.

## Task 12: Accept completion and repair the status surfaces

**Owner:** fresh sol_reviewer for acceptance; coordinator for reporting. **Files:** operations guide, active Task 7 status/plan pointers, final campaign report and immutable evidence index.

- [ ] Independently verify **five CLOSED blocker records + 30 live PASS probe records + two fault-injection PASS records**, exact compatible identities, complete cleanup, no pending/unknown effects and append-only accounting/history integrity.
- [ ] Verify all mandatory supporting controls (remote control, hooks/notify, apps/web, subscription provider, environment and reload handling), even without separate blocker IDs. No waiver by omission.
- [ ] Replace unconditional/stale status displays with evidence-derived current status. Preserve earlier failed/rejected evidence as history. Publish changed files, development verification, live results, costs and any limitations separately.
- [ ] Mark Task 7 complete only when the above acceptance succeeds. Otherwise report the precise remaining blocker, failed probe, unsupported control or allowance deficit. Stop before Task 8.

## Dependency and approval summary

Tasks 2 and 4 can proceed independently after scope/provenance review; Tasks 3 and 6 share configuration facts. Task 5 accounting and Task 7 recipe composition feed Task 8 feasibility. Task 9 freezes the integrated candidate. Tasks 10–12 remain gated execution with separate approvals.

Completed first implementation scope: **Tasks 1–4 only**, independently accepted and stopped before qualification execution. The structural parser, shared configuration preflight and ordinary build repair are complete. The next scope is Tasks 5–9; only then can a concrete, fully budgeted next live proposal be approved. Approval of this completed phase does not authorize that next scope or any live action.

No blanket vendor-support dependency remains. If pinned official behavior lacks a specific needed control, report that control and evaluate an official release or properly bounded target change; do not patch the runtime, invent private flags, skip policy sources or claim the blockers are already closed.
