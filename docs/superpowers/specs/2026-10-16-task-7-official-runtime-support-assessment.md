# Task 7 official-runtime support gate

> Historical assessment, superseded 2026-10-16 for active Task 7 planning by the [documented-integration design](2026-10-16-task-7-documented-integration-design.md) and [corrected plan](../plans/2026-10-16-task-7-blocker-resolution.md). The NOT MET result below concerns the retired stronger startup contract, not the availability of documented OAuth/app-server integration. Its bounded source findings remain evidence; its blanket stop on dependent implementation is no longer the design decision. The vendor inquiry is withdrawn/unsent. No code changed, blocker closed or launch authorized by this correction.

Date: 2026-10-16. Decision: **NOT MET / PRELAUNCH_AUTHORITY_UNPROVEN**. All five startup blockers remain OPEN. This is a support assessment, not executable policy, a qualification receipt, a seal, or permission to launch.

## Scope and decision

The user approved execution of the [conditional blocker-resolution plan](../plans/2026-10-16-task-7-blocker-resolution.md). Its first gate requires a supported official mechanism meeting the [runtime-support specification](2026-10-16-task-7-runtime-support-gap-spec.md). No complete mechanism was established in the inspected official CLI, bootstrap, initialization, configuration, thread-admission, and cloud-policy surfaces.

The result is a scoped evidence gap, not a repository-wide impossibility claim. Existing partial enforcement controls remain useful evidence, but they do not establish the complete startup contract. Dependent integration, campaign ledger changes, new drivers, new seals, and live qualification stop here. The [vendor inquiry](2026-10-16-task-7-vendor-support-inquiry.md) is prepared but unsent.

## Candidate and provenance

| Item | Evidence/status |
| --- | --- |
| Official candidate | 0.163.0, stable/non-draft, published 2026-10-15T21:30:38Z; latest-release pointer refreshed for this gate. |
| Source | Commit `83086188ae0614bd882818ff1aa23f3194962012`; annotated tag object `129b8ec7ee6f4511557a4856279f529025c25af4`. |
| Windows x86_64 candidate archive | `codex-x86_64-pc-windows-msvc.exe.zip`, 167080091 bytes. |
| Published archive digest | SHA-256 `dabdb4d16aaf10fea40b74811c96efddcd9138f122163b69ed604fcb3eb704c3`. This identifies the archive, not an extracted or installed executable. |
| Windows applicability | Official guidance recommends Windows 11; updated Windows 10 is best effort. MXC needs compatible capabilities and applicable policy. Exact supported host/build and MXC availability have not been established for this candidate. |
| Executable/build correspondence | Official release association and published digest are established. Archive contents, extracted executable/dependency identities, build attestation/reproducibility, and correspondence to the local installed binary are NOT VERIFIED. No executable archive was downloaded or installed. |
| Retained source baseline | 0.162.1 at `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`; prior independently accepted 52-blob audit retained. |

Sources: [release metadata](https://api.github.com/repos/openai/codex/releases/tags/rust-v0.163.0), [tag object](https://api.github.com/repos/openai/codex/git/tags/129b8ec7ee6f4511557a4856279f529025c25af4), [Windows archive metadata](https://api.github.com/repos/openai/codex/releases/assets/645225139), [Windows sandbox guidance](https://learn.chatgpt.com/docs/windows/windows-sandbox). Release metadata is not proof of the required runtime behavior. Legacy sandbox behavior is not a replacement for the selected MXC boundary.

## Gap-to-interface mapping

All source references below are pinned to the candidate commit. UNKNOWN means evidence is insufficient, not that the capability is necessarily absent.

| Gap | Official interface/enforcement evidence | What prevents acceptance |
| --- | --- | --- |
| G1 Complete policy binding | [Configuration read schema](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server-protocol/src/protocol/v2/config.rs#L389); [thread parameters](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L62). | These inspected schemas do not expose a complete prepared-policy binding for actual process startup. Full ordinary/managed/cloud applicability and atomic admission remain unestablished. |
| G2 Early remote activation | [Startup prohibition check](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/lib.rs#L765); [remote RPC persistence](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/remote_control_processor.rs#L41). | Effective denial is a partial control; it must belong to the actual startup load before initialize-triggered activation. Saved-state resolution is separate. The daemon-settings mutation is not a read-only pre-process authority source. |
| G3 Browser/computer enforcement | [Feature declarations](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/features/src/lib.rs#L310); [requirements projection](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server-protocol/src/protocol/v2/config.rs#L434). | Complete native/external/extension/CDP consumer coverage and denial timing remain UNKNOWN. Parsed or projected controls do not establish enforcement at every effect. |
| G4 Restricted bootstrap effects | [Startup sequence](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/lib.rs#L531); [app-server CLI](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/cli/src/main.rs#L571). | Normal bootstrap loads authentication/cloud policy and initializes environment, state, and identity before metadata inspection. No complete restricted-entry/effect-budget contract was established in these surfaces. |
| G5 Stability and recovery | [Cloud loader](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/cloud-config/src/bundle_loader.rs); [cloud service](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/cloud-config/src/service.rs); [connection gate](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/connection_rpc_gate.rs#L1). | Internal snapshots, refresh and connection admission do not establish public all-policy validity, exclusive consumption, revocation or crash reconciliation for the proposed operation. |
| G6 Supported integration | [CLI dispatch](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/cli/src/main.rs#L1237); [initialize capabilities](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server-protocol/src/protocol/v1.rs#L29). | Existing invocation/metadata interfaces are identified. A supported authority issuer, consumption transport and startup receipt are UNKNOWN. No hypothetical wire format is adopted. |

The focused source comparison found configuration protocol and cloud loader/service text unchanged from the pinned baseline. Material candidate changes include projectless global config loading, explicit OS cwd capture for startup, a Windows MXC requirement check, and managed-daemon remote-preference persistence. These changes need adoption review if a supported path becomes available; none closes the gate by itself. [Config manager](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/config_manager.rs#L191), [startup](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/lib.rs#L531), [daemon settings integration](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/lib.rs#L975).

## Requirement-level acceptance

Every row requires documented Windows applicability, official binary/source correspondence, and later independent qualification in addition to its listed mechanism. None is accepted as the complete contract today.

| Requirement | Current result and missing evidence |
| --- | --- |
| R1 Human/machine intersection | NOT ESTABLISHED: human approval cannot prove effective host policy; no supported enforcing intersection for this startup purpose was identified (G1/G6). |
| R2 Trusted issuer/consumer | UNKNOWN: identify supported issuer trust and runtime consumer before effects (G6). |
| R3 Independent preparation envelope | NOT ESTABLISHED: authorize and enforce preparation before discovering later policy, without circularly justifying its own auth/network/write effects (G4). |
| R4 Complete bound intent | UNKNOWN: bind full identity, argv, cwd/ancestry, environment, profile, provider/account/workspace, provenance, policy revisions, effects and budgets. Actual PID identity is post-creation evidence, not pre-creation input authority (G1/G6). |
| R5 Same-policy consumption | NOT ESTABLISHED: authoritative snapshot lease or revision admission, revocation/disconnect semantics and reload control remain unsupported by the inspected public surfaces (G1/G5). |
| R6 Exclusive durable use | UNKNOWN: no supported reservation/consume/reconcile primitive was identified; local one-use handles do not establish cross-process durable consumption (G5/G6). |
| R7 Gates before activation | PARTIAL ONLY: [plugin startup gate](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core-plugins/src/manager.rs#L2824), [managed feature pins](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/config/managed_features.rs#L175), [MCP filters](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/config/mod.rs#L1781), and remote checks exist. Complete timing, applicability, browser coverage, startup inventory and later worker reload safety remain unqualified (G1-G4). |
| R8 Exact permitted effects | UNKNOWN: public enforcement of the complete preparation/startup effect envelope and actual request/retry/write/resource counters was not established (G4). No current effect grants result. |
| R9 Scope-bound receipts and cleanup | UNKNOWN: trusted preparation/consumption receipts and bounded cleanup accounting, including brokered work, are not established by metadata or Job ownership alone (G5/G6). |
| R10 Counterexample acceptance | PENDING: source/asset provenance is partial evidence; build correspondence and the specification's adversarial runtime cases have not been qualified. |

Current [app-server documentation](https://learn.chatgpt.com/docs/app-server) describes initialized metadata inspection. [Managed configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration) describes policy delivery, precedence and caching. Do not promote either description into a public all-policy startup freeze or consumption guarantee. No actual host/account/policy state was inspected for this gate.

## Separate operation purposes and blockers

| Purpose | Gate still required |
| --- | --- |
| Preparation | Independent restrictions and finite effects before policy resolution. |
| Metadata | Supported startup binding, owned inert entry, exact four-message exchange, then terminal fence/drain. The existing 50-second metadata bound remains unchanged. |
| Worker/thread | Separate current authority for safe startup, thread creation, subscription/model/tool effects, and complete MCP/hooks/config reload control. Metadata cannot upgrade to worker authority. |
| Independent verifier | Separate binding for sandbox startup, managed/auth/cloud loads and each fixed command. The historical two-probe receipt does not supply authority for a changed target. |

| Startup blocker | Status and next evidence |
| --- | --- |
| PLUGIN_STARTUP_UNPROVEN | OPEN: partial source gate is not effective-policy-bound startup proof. |
| BROWSER_COMPUTER_STARTUP_UNPROVEN | OPEN: complete enforcement paths and timing remain unknown. |
| MCP_INVENTORY_UNPROVEN | OPEN: all-source inventory/suppression, thread creation and reload safety remain unqualified. |
| MANAGED_REQUIREMENTS_UNVERIFIED | OPEN: actual complete applicable policy and supported pre-process binding remain unestablished. |
| STRICT_CONFIG_RUNTIME_UNVERIFIED | OPEN: precise source-supported negative input is now known; runtime positive/negative evidence remains pending. |

Remote control, hooks, legacy notifications, provider/environment effects, and reload safety remain additional required gates. No new qualification target was prepared. Historical 2 PASS / 30 UNTESTED results belong to their original target; the current changed source cannot inherit those passes.

## Strict-config test specification, not a runnable authorization

The future direct-stdio positive baseline uses supported strict configuration and the approved permission profile through recognized configuration, with actual OS cwd set explicitly. Do not confuse named user-config `--profile` with `default_permissions`; direct app-server does not accept the former route established by the audit. The exact candidate invocation must still pass integration review.

For the negative case, add two argv elements, `-c` and `foo="bar"`, to that same reviewed baseline. Require rejection attributable specifically to ``unknown configuration field `foo` in -c/--config override``. The payload is well-formed TOML, and the strict validator rejects its unknown key. Send no RPCs to the negative case. Persist only an allowlisted classification rather than raw stderr. A different config/policy error, unsupported CLI flag, timeout or unexplained exit is inconclusive/failure. The positive case performs only the permitted metadata exchange, then drains; no thread RPC follows. [Strict validator](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/config/src/loader/mod.rs#L656).

Both cases require prior authority. Early strict rejection is not a workaround for the startup gate.

## Stop and resumption conditions

The support assessment and unsent inquiry are the executable portion of this plan under the current evidence. A supported vendor response or official release must substantiate the missing mechanisms and identify interfaces, enforcement points, Windows/build applicability and limitations. Independently review that evidence and the resulting concrete integration contract before proceeding. Any alternative pre-activation architecture needs a separate reviewed decision; it cannot retroactively authorize process creation.

The user's implementation request does not override the plan's explicit dependency stop. No runtime installation, personal config/credential/database inspection, provider/helper/sandbox process, thread start, new fixture/seal, live probe, support message, commit, push or dependent code/test change was performed. The 40-minute campaign is still a design, not an active grant.

Supporting review/preservation records are under `.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-official-runtime-support-gate/`. This document does not update any qualification ledger or erase historical evidence.
