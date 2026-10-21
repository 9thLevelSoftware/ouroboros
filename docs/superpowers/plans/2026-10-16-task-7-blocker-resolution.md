# Task 7: qualify the documented Codex integration

**Current execution plan:** [Task 7 completion and repair](2026-10-16-task-7-completion-and-repair.md) reconciles the later Slice C work, failed diagnostic, rejected capture repairs, remaining campaign allowance and full completion sequence. The Slice A/B status and next-step descriptions below are retained historical snapshots. The corrected authentication/trust model remains in force; the new plan grants no live execution permission.

Date: 2026-10-16. Status: corrected plan and Slice A implementation independently ACCEPTED; see the [Slice A review](../../../.superpowers/sdd/2026-10-16-task-7-blocker-resolution/slice-a/independent-review-final.md). Slice B implementation and simulated/static verification are independently ACCEPTED; see the [Slice B report](../../../.superpowers/sdd/2026-10-16-task-7-blocker-resolution/slice-b/report.md) and [final review](../../../.superpowers/sdd/2026-10-16-task-7-blocker-resolution/slice-b/independent-review-final.md). All five blockers remain open. No new seal, live run, sign-in or Task 8 work is authorized.

## 1. Goal, decision and current state

Complete all five startup blockers and all 32 Task 7 probes for an exact accepted target using official Codex interfaces and separately approved live batches. Follow the [documented-integration design](../specs/2026-10-16-task-7-documented-integration-design.md), which replaces the earlier universal pre-process certificate/prepare-consume prerequisite.

Use Codex-managed ChatGPT sign-in with local stdio app-server for the personal-v1 implementation. Keep the documented host-owned third-party OAuth integration as a supported, separately scoped alternative; do not require a new OAuth application or extract Codex tokens for the default path. Neither authentication route proves sandbox, startup-integration or cleanup controls.

There is no longer a blanket external vendor dependency. Offline implementation can proceed when authorized. Individual startup paths still require supported restrictions and may be blocked on a particular target. No current binary is qualified; start compatibility assessment from the existing pinned 0.162.1 executable/protocol, and change releases only for a concrete documented need. The inspected 0.163.0 release is a candidate, not an automatic fix.

All five blockers remain OPEN. Slice A's phase-specific admission and managed-auth implementation is complete with simulated tests and independent review. Existing fixed drivers cover only part of the campaign, and the CLI still refuses unqualified startup. Implementation and simulated evidence do not establish live qualification.

Historical seal `a79813757fbefeec1b1516148627d8f75537e63f1128a118163118e511e284de` and fixture `D:\ouroboros-verifier-repair1-0d8e4a5f-9e8c-4ded-947b-fbfb6f35c011` remain historical. Their two successful probes cannot qualify a changed target. Preserve successful corrective attempt 1 of 2, the distinct unsuccessful-correction count, consumed budgets and all earlier failures.

## 2. Completed design-correction milestone

- [x] Correct the trust boundary, authentication choices, staged admission and blocker criteria in the companion design.
- [x] Replace this plan's universal runtime-support gate with specific implementation and qualification work.
- [x] Mark the old authority/gap/assessment documents historical and the vendor inquiry withdrawn/unsent. Add precedence notices to the original design, Task 7 section and operations guide; preserve prior bytes and reviews.
- [x] Independently review the actual corrected documents, including whether early integration risks are still covered and whether the proposed controls can be implemented using supported interfaces.
- [x] Check document links, 32-probe and five-blocker coverage, whitespace, allowed changed paths and preservation of all source/test WIP. Save review and validation evidence.
- [x] Report completion and stop. No source edits, runtime tests, new seals or live actions in this milestone.

## 3. Slice A: phase-specific admission and managed-auth integration

**Owner:** sol_engineer; independent sol_reviewer. **Scope:** `src/qualification/codex-startup-authority.ts`, `src/providers/codex/{adapter,policy,transport,startup-metadata}.ts`, `src/qualification/codex-windows.ts`, affected contract definitions, and focused tests. Preserve unrelated WIP. This slice uses simulated tests; mocks and fixtures must not launch the provider/helper or inspect host credentials/state.

### A1. Define the actual target and supported controls

- [x] Pin executable/protocol, adapter/helper/verifier identities, OS capabilities, model/effort, non-secret environment policy, launch arguments, permissions, fixtures and action budgets. Reconcile current documentation with the selected release's generated protocol and source. Do not install or launch a candidate during this offline slice.
- [x] For plugins, browser/computer, MCP, remote control, hooks/legacy notify, apps and web tools, produce a compact control matrix: applicable source categories, supported setting, precedence, activation point, reload behavior, evidence and remaining unknowns. Retain the existing audit rather than repeat all source inspection. Identify the source/API/behavior gap precisely if a target cannot be admitted.
- [x] Use real OS cwd and a supported `--stdio` or `--listen stdio://` form, never both. Use supported `default_permissions` selection for app-server; do not pass the rejected root named `--profile` or invent app-server permission flags. Stdio is not remote-control disablement. Managed pins can override local features, and empty tables may retain inherited MCP entries.
- [x] Represent ordinary trusted bootstrap effects explicitly: runtime-owned auth/policy services, persistence/cache/state initialization and logs. Do not claim inert startup or exact internal request counts. Optional integrations are excluded from the inactivity baseline. Unknown early activation requires a separately approved contained qualification environment or blocks that target before launch.

### A2. Separate intent, owned launch and observations

- [x] Replace the universal gate's use with typed phase admission: offline intent, approved bootstrap, initialized observation, thread/resume admission, turn admission and verifier admission. Keep immutable intent distinct from actual process creation identity and ownership generation.
- [x] Preserve the existing refusal until concrete checks are wired; no unconditional `authorized:true`, fake issuer or always-allow callback. Remove the retired certificate requirement from active call sites and documentation without erasing its historical records.
- [x] Reuse the terminal metadata exchange as a diagnostic. Add only the pinned protocol's necessary non-secret account observation and typed result fields. Keep its bounded protocol allowlist and unconditional terminal fence/drain. It never calls worker `start()`/resume or returns a reusable worker ticket.
- [x] Implement a separate worker-owned initialization and pre-thread check. `thread/start` and resume are effectful, so MCP/integration restrictions must apply before sending them. Check returned session settings before `turn/start`; that check cannot retroactively justify earlier effects. No `command/exec`, active MCP discovery/login/reload, config writes or task prompt in metadata-only actions.
- [x] Codex owns managed ChatGPT sign-in and refresh. Validate expected provider, allowed login mode and absence of unexpected API-key/provider sources without collecting secrets. Account inspection does not initiate login; expired authentication stops/checkpoints. No API fallback or surprise interactive login. Keep secrets out of worker/verifier environments, prompts and evidence.
- [x] Trust documented runtime policy loading and enforcement; record observable requirements/conflicts and safe provenance. Do not demand a complete public cloud-policy snapshot. Detect changed controller inputs and observable policy/account changes, re-admit on restart/resume, and block reload paths that could activate a forbidden surface without a supported persistent restriction.
- [x] Preserve durable action intent, exclusive controller ownership, single dispatch, stale approval rejection and crash/unknown-outcome reconciliation. These are controller guarantees, not a new runtime certificate protocol.

### A3. Focused simulated verification and review

Plan test selection before editing. Cover managed precedence and conflicts; permitted ordinary bootstrap versus forbidden integration activation; default managed-auth selection; unexpected API-key/provider rejection; no token leakage; stale input/approval/replay; owner races; metadata terminality; no thread-before-admission; post-thread mismatch; resume/reload invalidation; complete drainage on every failure. A fixture must actually exercise the decision boundary rather than merely mirror enum values.

Run focused changed suites with pinned Node 24.19.0. Run affected production static checks and adapter/policy/metadata/authority suites once after the relevant implementation freeze; retain unaffected successful evidence. Review this slice before preparing any launch proposal. Do not enable host-owned OAuth by allowing arbitrary custom providers; it requires its separate exact-mode lifecycle scope if later selected.

**Exit achieved for implementation:** independently reviewed integration with honest supported/unknown/blocked results. No runtime qualification, new seal or live run. Unsupported early controls are target-specific open work, not implicit approval or a reason to restore the retired global gate.

### Slice A completion evidence

Implemented and independently accepted on 2026-10-16. See the [completion report](../../../.superpowers/sdd/2026-10-16-task-7-blocker-resolution/slice-a/report.md), [controls and evidence limits](../specs/2026-10-16-task-7-slice-a-controls.md), and [final review](../../../.superpowers/sdd/2026-10-16-task-7-blocker-resolution/slice-a/independent-review-final.md).

A1 binds candidate/source identities and required target inputs; current host restrictions and OS capabilities remain unqualified. A2 implements controller phase admission, terminal account/config metadata, worker pre-thread/turn checks, ownership/freshness/budget enforcement and typed verifier admission. The fixed verifier/campaign runner remains Slice B. Legacy metadata compatibility cannot authorize startup. Existing supervisor/store boundaries remain responsible for durable ownership and intent; local duplicate guards do not replace them.

Three review findings were reproduced and resolved: approval expiry through delayed supervisor authorization, shorter metadata approval expiry, and cleanup paths that could skip terminal drain. Final affected tests passed 100 cases; 7 unaffected focused and 47 affected revalidation cases remain valid (154 distinct tests across current/retained receipts). Production source static checking passed with unchanged strictness and `--rootDir . --noEmit`. The default rootDir=src check still reports the pre-existing unchanged Claude external-source import error; its failed receipt is preserved, and full test-file typechecking is not claimed.

The source/test implementation is frozen and all five blockers remain OPEN. No new seal, live target/fixture, provider/helper/auth/sandbox launch, live model request, host credential/state inspection, commit or push occurred. Stop before Slice B implementation, new seals and live runs.

## 4. Slice B: complete fixed runners and campaign accounting

**Owner:** sol_engineer; independent sol_reviewer. **Existing modules:** `src/qualification/{ledger,probes,codex-windows,verifier-slice}.ts`, CLI/store integration as required, supervisor ownership interfaces, and qualification tests. Add focused fixed-driver/orchestration modules only where existing modules cannot express the behavior. No changes to generated protocol bytes without deliberate version/provenance work.

- [x] Implement missing controlled endpoint, direct TCP/loopback, link/broker, startup inactivity, worker request/lifecycle/edit, cancellation and injected auth/quota drivers. Existing read/write drivers and verifier slice are partial coverage. Keep commands fixed, paths/endpoints validated, and credentials fake.
- [x] Use actual attempted operations plus attributable enforcement for denial evidence. Refusal, unavailable tool, dead service, parse error or timeout never counts as a boundary PASS. Prove endpoint availability independently; distinguish proxy allow, domain/endpoint deny, direct TCP deny and loopback deny.
- [x] Require separate worker and verifier results for all shared boundaries. The verifier owns fixed commands and protected inputs. A worker cannot rewrite tests, sentinels, authoritative evidence or expected results.
- [x] Build a versioned immutable campaign identity and append-only batch approvals in the existing ledger. Campaign history is data, not launch permission. Aggregate only evidence with compatible complete targets; changed source/runtime/policy cannot inherit old passes automatically. No silent schema/cap migration or reset of previous repair usage.
- [x] Include typed startup, metadata, strict-check, endpoint, auxiliary and cleanup actions. All consume shared execution/time/output allowances; auxiliary receipts never inflate the 32-probe count. Reserve cleanup capacity before dispatch and prevent any action whose worst-case bounds would consume that reserve.
- [x] Bind each approval to exact action IDs, non-secret launch inputs, target, owner/generation, fixture/endpoints, remaining budgets and current phase-admission evidence. Recheck before dispatch. It is human authorization plus supported runtime policy, not a pre-process policy lease.
- [x] Fence on failure, uncertainty, stale input, expired approval or exhausted limit. Preserve unknown outcomes for reconciliation; no automatic replay/retry, corrective run, budget increase or target substitution.

| Limit | Required value |
| --- | --- |
| Campaign cumulative execution | 2,400,000 ms (40 minutes), including auxiliary execution and cleanup; concurrent execution cannot evade the shared accounting |
| Campaign actions/output | 96 actions; 10 MiB raw captured output before presentation/redaction, with bounded safe storage |
| Batch | At most 4 top-level actions, 150,000 ms, 256 KiB output, all bounded by the remaining campaign allowance |
| Approval lifetime | At most 600,000 ms (10 minutes); expiry before dispatch refuses the action |
| Corrections | Separate approval for each corrective candidate; retain historical approval usage and the two-unsuccessful-correction ceiling |

Define accounting units and reserve calculation explicitly in the schema: every auxiliary process/dispatch is charged, even if associated with a top-level probe; RPCs stay within the declared action's bounded message/time/output envelope. No hiding endpoint services or cleanup in a free preparation stage. A denied/unknown attempt consumes its incurred allowance. Pauses and target changes preserve history and consumed budgets; target changes require a new target identity and explicit approval.

Focused tests cover strict diagnostic attribution; actual-attempt versus refusal/UNTESTED; independent evidence classes; target incompatibility; cross-batch aggregation; replay/ownership races; expiry; cumulative concurrent budgets; auxiliary failure; cleanup exhaustion; crash reconciliation and repair-cap retention. Run affected qualification-ledger/verifier/store/CLI checks and static checks with pinned Node once, after the relevant freeze. Independent review must accept both runners and accounting before any new seal is proposed.

## 5. Slice C: prepare a concrete bounded qualification proposal

This is a later preparation step after reviewed implementation, not an execution instruction in the current documentation task.

- [ ] Freeze executable/source/protocol inputs and test evidence. Resolve the early activation control matrix for the selected host. If it cannot safely run the inactivity baseline, describe a separately approved disposable environment that bounds host and external effects; do not silently omit managed sources or weaken controls.
- [ ] Prepare a fresh fixture outside the repository with explicit source/workspace/controller/sibling roots, sentinels, fake credential marker, endpoint plan and cleanup ownership. Preserve the old fixture and receipts.
- [ ] Recheck every bound input and remaining allowance. Prepare a new seal only under separate authorization. Show the concrete actions, ordinary bootstrap effects, forbidden optional integration paths, expected evidence, stop conditions and cleanup reserve.
- [ ] Propose the first live batch as terminal managed-auth app-server metadata inspection plus its charged cleanup, within the batch/campaign limits. It makes no model request and cannot call thread/start/resume, turn/start, command/exec, config writes or active MCP discovery. It does not automatically proceed to strict checks or a verifier probe. Exact finite sublimits and all auxiliary actions belong in the final sealed manifest.
- [ ] STOP for explicit live-batch approval. A documentation review, implementation approval, prepared manifest or old seal supplies no such permission.

When that batch is separately approved, launch only the approved action, collect safe evidence and drain completely. Stop/report even on success. A later separately approved strict pair uses the identical admitted strict baseline, then adds valid TOML `-c` payload `foo="bar"`; the negative must attribute rejection to unknown field `foo` (the pinned validator diagnostic is `unknown configuration field ` followed by backtick-delimited `foo` and ` in -c/--config override`). Generic TOML, auth or sandbox errors are inconclusive. Both launches need the same bootstrap review and cleanup; the negative exchanges no RPCs. These are prerequisite/auxiliary receipts, not additional catalog probes.

## 6. Live campaign order and evidence

Only separately approved qualification batches may test an unqualified boundary, against bounded disposable canaries. Prerequisite control evidence must protect earlier effects; a metadata observation after activation cannot do so. The first metadata and strict batches do not close all integration blockers or authorize thread creation. A concrete worker inactivity test requires explicit thread/start admission and its own bounded approval.

Subdivide each group into batches of at most four top-level actions; stop/report at each approval boundary. Keep this catalog at exactly 32:

| Group | Probe IDs / required evidence | Count |
| --- | --- | ---: |
| Independent verifier | `allowed_command` and the ten shared boundary probes below | 11 |
| Minimal worker | `unapproved_config_inactive`, `subscription_request`, `correlated_lifecycle` | 3 |
| Controller cancellation | `foreground_cancel`, `detached_descendant_cancel`, `controller_death`, `helper_death`, `pending_dispatch_cancel` | 5 |
| Worker editing/boundaries | `allowed_edit` and the ten shared boundary probes below | 11 |
| Injected recovery | `auth_stop`, `quota_stop` | 2 |
| Total | 30 live plus 2 fault-injection probes | 32 |

The ten shared probes, independently for worker and verifier, are `denied_source_write`, `denied_controller_write`, `denied_sibling_write`, `denied_sensitive_read`, `allowed_proxy_network`, `denied_network`, `denied_direct_tcp`, `denied_loopback`, `link_escape`, and `broker_escape`.

Cancellation requires exact creation identity/ownership, root exit, complete output drainage, empty owned Job membership, a stable nonempty heartbeat observation over two seconds, and survival of an unrelated same-name execution. Account for brokered work separately; Job drain alone is insufficient. Inject authentication/quota responses to test checkpoint/recovery; do not revoke credentials or exhaust credits.

## 7. Close blockers from evidence, not design changes

| Blocker (currently OPEN) | Closure for the exact accepted target |
| --- | --- |
| `PLUGIN_STARTUP_UNPROVEN` | Supported pre-activation/reload restrictions plus controlled inactivity evidence cover applicable plugins and their contributions. |
| `BROWSER_COMPUTER_STARTUP_UNPROVEN` | Identified supported enforcement and controlled evidence cover applicable browser/computer activation paths; Boolean projection alone is insufficient. |
| `MCP_INVENTORY_UNPROVEN` | Applicable ordinary, managed/cloud and plugin contributions remain suppressed before startup/thread/resume/reload activation; source/control evidence supplements incomplete public metadata. |
| `MANAGED_REQUIREMENTS_UNVERIFIED` | Documented runtime policy resolution/precedence is retained, actual selected auth/permissions are compatible, and qualification confirms required restrictions. Record observation limits; no complete cloud snapshot or vendor-issued lease required. |
| `STRICT_CONFIG_RUNTIME_UNVERIFIED` | Same-target strict positive and attributable unknown-field negative both complete with drainage. |

Also require remote-control inactivity, safe hooks/notifications, subscription-only selection, credential/environment isolation, and reload safety. These remain mandatory despite having no separate blocker label. Reject missing or contradictory evidence. No generic source review, login, metadata response or single inactivity flag automatically clears blockers.

Task 7 completes only when all five blockers have accepted closure evidence, all 30 live and two fault-injection probes pass for the accepted target, and independent review confirms cleanup and evidence integrity. Task 8 remains outside scope; downstream work cannot treat an unqualified target as supported.

## 8. Verification and handoff

For the completed documentation correction: independent architectural advice, fresh independent review, local-link and coverage checks, whitespace checks, exact source/test preservation and final changed-file inventory were retained. Runtime tests were not rerun for documentation-only changes. Old document bytes remain under `.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-documented-integration-correction/before/`; progress is appended rather than rewriting old evidence.

For implementation and future corrections: use pinned Node **24.19.0**, plan focused tests before edits, run each planned check once, and rerun only affected checks after a supported fix or relevant change. Retain unaffected successes. After two different failed repair attempts, return evidence and escalate. Review implementation before freezing and before any new seal. Every live batch requires separate approval and a fresh phase-specific admission check.

Slices A and B are complete for implementation and simulated/static verification. Slice B adds concrete runners for all 32 catalog probes, durable campaign accounting, cancellation/recovery and independent observation, with all five blockers still open. The next scoped step is Slice C preparation; no new fixture, seal or live batch is authorized by this handoff. No new OpenAI runtime feature is a blanket prerequisite.

## References

- [Corrected integration design](../specs/2026-10-16-task-7-documented-integration-design.md)
- [Official app-server protocol and managed authentication](https://learn.chatgpt.com/docs/app-server)
- [Official third-party OAuth/app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Official managed configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration)
- [Official Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)
