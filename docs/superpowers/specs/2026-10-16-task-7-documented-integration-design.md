# Task 7: documented OAuth and app-server integration

Date: 2026-10-16. Status: corrected design independently ACCEPTED; see the [review record](../../../.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-documented-integration-correction/independent-review.md). The user authorized design and plan corrections, practical security checks, and independent review; this document authorizes no implementation, seal, runtime launch, sign-in, or live qualification.

## 1. Decision and precedence

Use the official Codex app-server integration and restore the personal-v1 authentication choice in the [original design](2026-10-13-ouroboros-design.md): Codex-managed ChatGPT sign-in over local stdio. OpenAI also documents a third-party OAuth route for eligible open-source/local applications. It is a supported alternative with its own registration and token lifecycle, not a missing vendor feature.

Trust the selected official runtime to perform its documented authentication, policy loading, cache/state maintenance, and agent orchestration. Ouroboros owns dispatch approval, process ownership, command boundaries, evidence, and cleanup. OAuth establishes authorized model access; filesystem, network, integration, and cancellation controls require their own qualification.

The previous requirement for a new runtime-issued pre-process certificate, complete cloud-policy snapshot, exclusive prepare/consume lease, and per-bootstrap-effect counter was an additional project design, not a prerequisite of documented OAuth/app-server use. It is retired from active Task 7 acceptance. No vendor response is required to begin the offline integration work described in the [corrected plan](../plans/2026-10-16-task-7-blocker-resolution.md).

This design and that plan supersede conflicting startup requirements in the [offline authority design](2026-10-15-task-7-startup-authority-design.md), [runtime-support gap specification](2026-10-16-task-7-runtime-support-gap-spec.md), and [support assessment](2026-10-16-task-7-official-runtime-support-assessment.md). Their source observations and original review records remain historical evidence. The [vendor inquiry](2026-10-16-task-7-vendor-support-inquiry.md) is withdrawn and unsent. Historical findings about missing strong guarantees remain valid for that stronger contract; they do not establish that ordinary supported integration is unavailable.

All five startup blockers remain OPEN. Native Codex remains UNQUALIFIED. No historical probe is promoted into a pass for a changed target.

## 2. Authentication paths

| Path | Selection and ownership | Required safeguards |
| --- | --- | --- |
| Codex-managed ChatGPT sign-in | Selected personal-v1 default. Codex performs documented sign-in and credential refresh; Ouroboros observes non-secret account/auth status. | Explicit provider selection, environment allowlist, expected subscription mode, no token extraction, no API-key or provider fallback. Interactive login is a separately approved user action if required. |
| Host-owned third-party OAuth | Supported alternative, outside the next implementation slice. The application registers and obtains its own authorization for ChatGPT plan usage, owns secure storage/refresh, and supplies its access token through the documented custom Responses provider. | Separate auth-mode schema, exact provider/base URL, registration and state/nonce/PKCE validation, credential privacy, controlled refresh/restart/resume, applicable distribution eligibility, and separate qualification. Never borrow Codex-managed credentials. |

The [third-party integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) documents an application-owned `ACCESS_TOKEN` with the `openai_chatgpt_plan` provider, `https://api.openai.com/v1`, `wire_api="responses"`, `requires_openai_auth=false`, and `supports_websockets=false`. That OAuth bearer route is not API-key fallback. In a future explicit selection of this mode, reject unexpected credentials while permitting the exact approved OAuth environment key; do not classify it as unsafe merely because it is a custom provider. Its secret must be restricted to the trusted runtime and excluded from worker command environments, logs, manifests, and evidence. That isolation needs tests before this alternative is enabled.

The [OAuth overview](https://developers.openai.com/siwc/token-sharing-open-source) supplies application-registration and lifecycle requirements. The app-server's experimental `chatgptAuthTokens` flow is another distinct interface; do not conflate it with the documented custom Responses provider example. No OAuth application registration or credential migration is needed for the selected managed-auth path.

For either path, a model-list entry is not entitlement evidence. Task 7 still requires an actual permitted subscription-backed request. Authentication expiry or quota response checkpoints the run; it never switches billing or accounts. Existing extra-usage settings remain visible where observable, so subscription mode does not promise zero cost.

## 3. Trust boundary and permitted startup effects

The trusted computing base includes the pinned official runtime, controller, supervisor/helper, selected OS sandbox, and runtime-managed account/policy services. Agent-generated commands, repository content, inherited optional integrations, and tool output are outside that boundary. Trusting runtime authentication does not grant a repository command access to credentials or controller data.

A later bounded bootstrap approval may permit normal runtime-owned auth refresh, policy retrieval, cache/credential persistence, state initialization/migration, installation identity, and logging in their documented runtime locations. Record these categories in the proposal, along with applicable network service classes, deadlines, output limits, process identity, and cleanup. Do not promise zero effects, exact HTTP counts, or command-sandbox confinement of the runtime's own authentication traffic. Do not instrument or read token contents to manufacture proof. If those ordinary effects are unacceptable for the selected host, choose a separately approved disposable environment or stop that target.

This bootstrap trust does not implicitly include plugin execution, MCP services, browser/computer control, remote-control listeners, hooks, notification commands, or repository instructions causing execution. Their activation must be assessed separately. The qualification baseline keeps optional integrations inactive. An integration that is needed later requires an explicit design/scope change and its own qualification; its activation cannot satisfy an inactivity probe.

Use documented controls and preserve applicable managed/cloud policy. Local flags do not override stronger managed settings. A fresh home directory, an empty configuration table, or local transport selection alone is not proof that all inherited contributions disappeared. No private switches, patched runtime, skipped policy sources, weaker sandbox fallback, or controller-generated certificate substitutes for enforcement.

## 4. Staged admission and stop boundaries

These phases describe future implementation. Current work stops at documentation review.

| Phase | Admission and permitted activity | Stop boundary |
| --- | --- | --- |
| Offline preparation | Pin executable/protocol, OS, controller/helper/verifier, non-secret launch intent, configuration controls, environment policy, fixtures and budgets. Map known early activation paths to supported restrictions. | No runtime process, host login, thread, or model request. An unresolved early activation risk blocks only targets/actions that depend on it. |
| Separately approved bootstrap | Own and launch the official process with reviewed ordinary startup effects and supported integration restrictions. Bound time/output and reserve cleanup before dispatch. | No worker thread or prompt. Unknown early optional activation must be contained and explicitly approved in a disposable qualification environment, or launch is refused. |
| Initialized inspection | `initialize`, `initialized`, then bounded allowlisted account/configuration/requirements observations for the pinned protocol. Record conflicts and safe provenance. | A metadata-only action always fences and drains; its receipt cannot be reused to continue into a worker session. No `thread/start`, resume, `turn/start`, `command/exec`, MCP discovery/login/reload, or config write. |
| Worker session admission | A separate worker action repeats current checks in its own owned runtime. Admit thread creation/resume only when controls relevant to that operation and its integrations have qualified evidence or an explicit bounded qualification action. | `thread/start` can activate MCP and is an effectful boundary. Post-thread checks cannot establish earlier inactivity. Reject mismatched returned session settings before any turn. |
| Scoped worker turn | Admit only the approved task/probe with qualified filesystem/network/tool restrictions, protected verifier inputs and fresh batch permission. | No worker self-approval, expanded permissions, automatic retry, provider switch or unreviewed resume. Fence/drain on failure or loss of required assurance. |
| Independent verifier | Own a separate fixed-command execution through the documented sandbox path with its own policy admission, budget, and evidence. Its normal managed-policy/auth effects must also be approved. | Worker observations do not qualify verifier execution; verifier success does not authorize a worker. |

The controlled exception for qualification is explicit: an approved test may attempt an unqualified boundary against disposable canaries to measure it. Such approval describes the possible effects and containment; it never asserts that the tested boundary already works. On the user's real host, unknown pre-metadata integration activation is not acceptable merely because the process can later be killed. A disposable environment must bound host access and external integration destinations too; otherwise stop before launch.

Controller records separate immutable launch intent from actual root creation identity, PID, Job/helper ownership and generation. Fresh human dispatch approval plus runtime/OS policy governs an action. Controller intent hashes are useful freshness checks, not remote-policy certificates. Durable action intent, exclusive controller ownership, dispatch fencing, and crash reconciliation remain required controller properties. Unknown outcomes never replay automatically.

## 5. Practical startup checks

The earlier source audit remains useful: initialization can resolve remote saved state; plugin work may precede metadata; thread/resume/reload can start MCP; metadata reads are not an atomic global policy snapshot. Resolve the following per selected target and lifecycle phase:

| Surface | Pre-effect evidence and qualification obligation |
| --- | --- |
| Plugins and plugin integrations | Identify supported disablement and its enforcement timing, including managed feature precedence. Check plugin-provided MCP/tools are covered; later inventory alone cannot prove earlier inactivity. |
| Browser/computer | Identify the supported controls for applicable native, external/CDP, and computer paths. Trace enforcement at their activation boundary and test inactivity/denial with controlled canaries. One projected Boolean does not prove every path. |
| MCP | Account for ordinary, managed/cloud, and plugin contributions using documented configuration semantics and source evidence where projection is incomplete. An empty table may merge with inherited entries. Check thread/start, resume, and reload before allowing those operations. Avoid active discovery as a passive inspection shortcut. |
| Remote control | Use supported runtime enforcement that prevents activation for the selected startup. Stdio selects the app-server transport; it does not prove remote control is off. Saved-state handling and policy precedence matter. Never inspect the live state DB or invoke a remote server merely to discover whether it is safe. |
| Hooks, notifications, apps and web tools | Cover startup hooks and separate legacy notification commands, plugin-supplied paths, apps and web-search configuration. Disabled tool exposure alone is insufficient for earlier shell/notification effects. |
| Provider and environment | Explicit managed ChatGPT mode; reject unexpected provider/API-key precedence and injection-capable inherited environment. Permit runtime-required credential access only in the trusted runtime. Worker/verifier denial probes use fake credentials. |
| Managed policy | Trust documented runtime policy resolution/enforcement; identify applicable source categories and observable conflicts. Preserve managed restrictions. Demonstrate selected permission/provider behavior under effective policy, without requiring a complete controller-readable cloud snapshot. |
| Strict configuration | The same approved strict baseline must succeed; adding valid TOML `-c` payload `foo="bar"` must reject specifically for the unknown field. A parse error, auth error, or sandbox error is inconclusive. Both processes drain completely. |

For each early surface record `supported restriction + activation boundary + evidence`, `explicitly contained qualification attempt`, or `blocked target/action`. Do not record all unknowns as harmless, and do not convert one unknown into a universal unsupported-runtime conclusion. Source review guides launch design; actual probe evidence is still required for closure.

## 6. Policy changes, reloads and evidence validity

Rely on the official runtime's documented policy semantics. Record controller-owned input hashes and safe runtime observations, their times, scope, and source limitations. Reject observed conflicts with the approved policy. Do not expose raw config layers, environment values, tokens, private endpoints or account identifiers in receipts.

Fresh admission is required at restart/resume and after relevant account, configuration, runtime, environment, session or permission changes. A reload that might activate a forbidden integration must remain constrained by a supported control; otherwise do not enable that lifecycle path. Short approval expiry, repeated metadata reads, or a local hash cannot prove cloud-policy immutability. No promise of instantaneous global revocation or complete external change detection is made. Qualification records state these limits and retain only unaffected evidence with a complete valid target.

If the selected host's managed policy requires an incompatible integration or permission, stop that target and report the concrete conflict. Do not bypass policy, silently select another account/environment, or demand a new OpenAI certificate as the routine remedy.

## 7. Blocker closure rules

These labels retain historical continuity. Revised acceptance concerns the selected integration boundary and practical enforcement, not the retired prepare/consume protocol. All start OPEN; each requires accepted, target-specific evidence.

| Blocker | Required evidence for closure |
| --- | --- |
| `PLUGIN_STARTUP_UNPROVEN` | Supported restrictions cover applicable startup/reload plugin paths and contributions; controlled evidence demonstrates inactivity for the baseline. An approved bootstrap exception is not an inactivity PASS. |
| `BROWSER_COMPUTER_STARTUP_UNPROVEN` | Applicable activation paths have identified supported enforcement and controlled inactivity/denial evidence. Unknown applicable paths remain blocked. |
| `MCP_INVENTORY_UNPROVEN` | Suppression covers applicable ordinary/managed/cloud/plugin contributions before activation, including admitted thread/resume/reload paths. Use source/control evidence plus controlled observations where public metadata is incomplete; a full public inventory API is not itself required. |
| `MANAGED_REQUIREMENTS_UNVERIFIED` | Documented runtime precedence and policy loading are retained; approved auth/permission settings are compatible with observed requirements; qualification confirms relevant restrictions under the selected policy. Record visibility limits. A complete pre-process policy lease/certificate is not required. |
| `STRICT_CONFIG_RUNTIME_UNVERIFIED` | Positive strict baseline and otherwise identical unknown-field negative have attributable results, exact target linkage, and complete drainage. |

A source reading, configuration response, OAuth login, or successful model request alone closes none of these blockers. The unapproved-configuration inactivity probe supplies runtime observations but must be mapped to each surface; one generic success flag cannot clear them all. Startup/strict auxiliary evidence is retained separately from the 32-probe catalog.

## 8. Existing implementation and migration scope

The existing `codex-startup-authority.ts` deliberately refuses startup and consumes inspection inputs that already contain process identity. Keep that behavior unchanged in this documentation pass. A later migration replaces its use as a universal prerequisite with concrete phase-specific controller admission; it must not simply return `authorized:true`.

The terminal `startup-metadata.ts` exchange remains useful as a bounded diagnostic with drainage and output privacy. Its hard-coded unknown completeness/reload fields are observations, not a reason to invent an issuer. Its current RPC allowlist lacks account inspection and its provider classifier assumes `openai`; any future changes need focused tests. It must never become a reusable worker authorization ticket. The worker adapter keeps its separate owned lifecycle and pre-thread checks.

Existing adapter authorization callbacks are integration seams, not permission by themselves. Implement explicit control/target validation, process ownership and observed-policy checks. Preserve fail-closed behavior for missing controls, input changes, conflicting policy, unimplemented runners and stale evidence. New ledger/campaign schemas must preserve historical correction usage and budgets.

Keep the existing pinned 0.162.1 executable/protocol as the starting compatibility candidate; no version is declared qualified. Official 0.163.0 is another candidate if a concrete requirement warrants changing it. Recheck documented interfaces against the selected release before implementation; current documentation does not prove an older binary implements every field. A version change requires corresponding source/protocol review and requalification, not automatic replacement of history.

## 9. Evidence, completion and current stop

Retain all 32 probes: 11 verifier, 3 minimal worker, 5 controller cancellation, 11 worker edit/boundary, and 2 injected recovery cases. Required denials need actual attempted operations and attributable enforcement; refusals, missing tools, dead endpoints and timeouts are UNTESTED or FAIL, never PASS. Exact ownership, drainage, stable heartbeat, unrelated-process survival, link/broker escape and independent verifier evidence remain mandatory.

Historical seal `a79813757fbefeec1b1516148627d8f75537e63f1128a118163118e511e284de` and fixture `D:\ouroboros-verifier-repair1-0d8e4a5f-9e8c-4ded-947b-fbfb6f35c011` remain untouched. Their two passing verifier probes belong to their original target. Corrective attempt 1 of 2 was used successfully; retain that approval usage separately from unsuccessful-correction counts.

Current deliverables are this corrected design, the detailed Task 7 plan, aligned document notices, independent review, and documentation-preservation checks. No source/test code changes, test/runtime execution, credential handling, new seal, live run or Task 8 work occurs here. Future offline implementation is feasible without the retired vendor prerequisite. Actual readiness for each launch remains a target-specific result of supported-control assessment and subsequent separately approved qualification.

## Official references and retained evidence

- [App-server lifecycle and managed authentication](https://learn.chatgpt.com/docs/app-server)
- [Third-party ChatGPT-plan OAuth integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) and [registration/lifecycle overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Managed configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration)
- [Windows sandbox applicability](https://learn.chatgpt.com/docs/windows/windows-sandbox): Windows 11 is recommended; updated Windows 10 is best effort. Record actual OS capabilities and fail closed if required MXC/read/network controls are unavailable.
- [Strict validator at 0.163.0](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/config/src/loader/mod.rs#L656)
- Retained pinned-source audit and reviews: `.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-startup-evidence-audit/`; earlier runtime support assessment remains evidence for its historical contract only.
