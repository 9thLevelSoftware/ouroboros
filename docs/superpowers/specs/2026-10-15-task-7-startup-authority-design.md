# Task 7: offline startup-authority design

> Historical design, superseded 2026-10-16 by the [documented-integration design](2026-10-16-task-7-documented-integration-design.md) and [corrected Task 7 plan](../plans/2026-10-16-task-7-blocker-resolution.md). The universal pre-process authority prerequisite below is retired from active acceptance. The terminal metadata protocol, ownership, privacy and drainage work remains useful; the existing implementation is unchanged and does not authorize startup. Prior source findings/reviews remain historical evidence. No blocker is cleared and no launch is authorized by this correction.

Date: 2026-10-15. Status: design for independent review; no implementation or launch approval.

## Purpose and decision

Define the evidence and enforcement required to inspect native Codex startup configuration without creating a worker thread. The user authorized this document and independent review only. No implementation, test execution, Codex/helper/provider/auth command, host configuration change, commit or live qualification is part of this work.

Choose a separate metadata-only exchange with a runtime-enforced outbound protocol boundary. Do not call the existing worker adapter's `start()` or `resume()`. The exchange always terminates and drains its owned process after metadata inspection; a favorable result never continues into a thread.

Feasibility has three separate answers:

- **Offline control implementation is feasible:** the existing ownership API, bounded JSONL decoder and generated protocol support a finite exchange and verifiable shutdown. This is a design conclusion, not tested implementation.
- **A real metadata-only app-server launch is not currently ready:** effective early startup restrictions, their freshness and a supported way to establish them before process creation remain unproven. This document supplies no launch authority.
- **Worker startup remains unqualified:** the metadata methods do not expose every managed control and cannot eliminate the configuration-reload race before `thread/start`. No runtime limitation is declared impossible without evidence; unknown prerequisites remain blockers.

The accepted verifier result remains two PASS and 30 UNTESTED under its original target. Its read-denial and allowed-command evidence does not prove worker startup, subscription use, cancellation or any additional Task 7 probe.

## Evidence basis and limits

This design uses current repository source, generated Codex 0.162.1 protocol types, and retained pinned-source assessments. It does not re-inspect personal runtime configuration or retrieve new external sources. Source conclusions inherited from the retained assessment are identified as such, rather than represented as fresh runtime observations.

| Reference | What it establishes |
| --- | --- |
| `.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-startup-authority-review.md` | Retained source assessment: early plugin/remote-control/environment effects; direct-stdio metadata route; ordinary MCP and hooks at thread creation; managed-policy and reload gaps. |
| `.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-permission-override-semantics.md` | Pinned source commit `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`: recursive table merge, managed profile constraints, and sandbox loading with strict mode disabled. Empty tables do not erase inherited entries. |
| `src/providers/codex/adapter.ts:242-259` | Current worker flow initializes, reads account/configuration, then starts/resumes a thread before its observed-authority callback. |
| `src/providers/codex/transport.ts:35-114` | Existing method type union includes worker actions; public `send(unknown)` and lack of a runtime method gate make a typed facade alone insufficient. |
| `src/providers/codex/policy.ts:31-65` | Current projections drop effective plugins, notification state, remote-control state and origin/version information. Current policy specifically requires managed plugin disablement. |
| `src/providers/codex/protocol/0.162.1/typescript/` | Exact initialize/configuration request and response shapes. Requirements can genuinely be null; available fields are not a complete managed-policy inventory. |
| `src/qualification/probes.ts:22-40` | Required 32 probes and five currently unconditional startup blocker labels. |
| `.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-slice-repair1-live/report.md` | Independently accepted two-probe verifier result and its limits. |

Generated files remain untouched. The existing verifier test-file work in progress is outside this design's change scope.

## Authority phases

Distinguish three decisions. A successful later decision cannot repair missing earlier authority.

1. **Before process creation:** prove restrictions on effects that app-server may perform before initialization or a worker thread. Bind the exact runtime, environment, configuration scope and permissible runtime auth/cache effects. Failure means zero launches.
2. **During metadata inspection:** permit only initialization and the two configuration reads. The already-authorized process may reveal further restrictions or incompatibilities; an unfavorable result fences and drains it. Such observations cannot retroactively authorize startup.
3. **Before worker thread creation:** require complete effective tool/configuration restrictions, supported stability or enforcement across reload, and separate worker qualification authority. This design never reaches this phase and never issues a reusable worker authorization token.

The future startup packet must bind the exact executable and hash (Codex 0.162.1), pinned Node 24.19.0 and helper hashes, protocol/controller source hashes, fresh disposable workspace, canonical cwd and configuration ancestry, explicit MXC/profile arguments, exact child environment, request/action/owner generation, allowed outbound messages, budgets and evidence schema. Resolve all values before a future dry run; this design deliberately contains no executable launch command or new seal.

Use the reviewed eight-key environment shape (`SystemRoot`, `SystemDrive`, `WINDIR`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`), with absolute paths and SystemDrive consistent with SystemRoot. This is a candidate inherited from verifier evidence, not app-server environment qualification. Do not inherit ambient API keys, workload-identity selection, arbitrary provider variables or a shell. Normal managed loading and runtime-managed credentials stay in place. Do not copy tokens or invent an isolated home that silently drops managed restrictions.

## Blocker and evidence matrix

All five global labels stay open. Internally record phase-specific states: `UNKNOWN`, `CONFLICT`, `SUPPORTED_SOURCE_ROUTE`, or `OBSERVED_FOR_EXACT_TARGET`. A source route is not an observed pass. Do not implement clearance by deleting constants or accepting an operator's bare `safe=true` assertion.

| Existing blocker | Timing and available evidence | Required proof / remaining gap | Bounded candidate check and stop |
| --- | --- | --- | --- |
| `PLUGIN_STARTUP_UNPROVEN` | Before process creation: retained source says plugin startup tasks can precede a model turn; effective `features.plugins=false` suppresses them. Managed pins apply after ordinary settings. | Establish effective false for the actual startup load, including conflicting managed pins and freshness. Current adapter's managed-only requirement is stronger than the approved spec; changing it would need a separate reviewed correction. | A future constrained `features list` invocation can provide partial effective-feature observations, but cannot alone authorize app-server. Unknown provenance, conflict or an unclosed reload gap stops before spawn. Metadata later cross-checks plugins; it cannot grant retroactive authority. |
| `BROWSER_COMPUTER_STARTUP_UNPROVEN` | Conservatively before process creation: startup timing is not fully established. Pinned requirements expose master prohibition and feature restrictions. | Establish an applicable effective browser/computer prohibition, including contradictory enabled pins, using supported policy/provenance. Parser acceptance, absent fields and a generic local feature override are insufficient. | Review a supported requirements source before any process launch. Later metadata can compare `allowBrowserAndComputerUse` and relevant feature restrictions. If the only proof would come from launching the process being authorized, retain the blocker. |
| `MCP_INVENTORY_UNPROVEN` | Ordinary MCP connections are associated with thread creation in the retained direct-stdio assessment; early plugin contributions remain subject to the plugin prerequisite. | Before any future thread: establish complete ordinary/plugin server suppression and enforce it across reload. A proven applicable empty managed allowlist is a candidate route. Generated requirements do not expose that full allowlist; discovered per-ID disables do not prevent new IDs. | In the authorized metadata phase, privately project effective server entries without connection/status RPCs. Stop after collecting them. Do not run `mcp list`, `mcpServerStatus/list`, discovery, authentication inspection or connection probes. Keep worker clearance open. |
| `MANAGED_REQUIREMENTS_UNVERIFIED` | Before process creation for early effects, and before any later thread for worker policy. Local layer checks and verifier managed loading have narrower evidence. | Bind applicable requirements and ordinary cloud configuration, provider/login constraints, exact permission-profile selection and effective restrictions. A legitimate `requirements:null` means no requirements were reported by that method; it does not prove every startup control or cloud layer absent. | `config/read` and `configRequirements/read` may supply a secret-free comparison after authorized startup. Missing surfaces remain explicitly unknown. Preserve managed loading; reject conflicts, substituted profiles and unsupported provenance. |
| `STRICT_CONFIG_RUNTIME_UNVERIFIED` | Actual strict app-server loading, after early authority is established. The flag exists; sandbox behavior does not test it. | Demonstrate successful recognized configuration and rejection attributable specifically to strict configuration validation. An unknown CLI flag, generic parser error or invalid TOML alone is not sufficient. | Future separately sealed accepted/rejected startup cases. Before designing their runnable manifest, establish the exact strict-specific negative input and expected diagnostic from pinned source. That input is currently unresolved, so this pair is not seal-ready. Neither case may create a thread. |

Additional obligations must not disappear just because they lack one of the five labels:

| Obligation | Decision boundary |
| --- | --- |
| Remote control | Before process creation: prove applicable effective `allowRemoteControl=false` or the exact scoped persisted preference disabled/absent through a supported read-only evidence route. Scope includes effective database, account, target and client identity. `features.remote_control=false` is insufficient. No public read-only status route has been established; do not use daemon-disable or pairing/start commands, or invent a private marker. |
| Provider/environment startup | Before process creation: establish permitted provider/environment initialization and expected runtime auth/cloud-policy effects. Forbid command-backed provider auth, unexpected credential sources, API fallback and inherited workload identity. Metadata inspection is not necessarily offline: the runtime can fetch policy, refresh tokens and update its own caches. Those effects require explicit later authority, never token reads/copies by the harness. |
| Hooks and legacy `notify` | Retained source places ordinary hook engine construction at thread creation. Prove early plugin/executor contributions excluded before spawn. Record effective hooks false and notification state during metadata inspection; legacy `notify` is separate from the hooks flag. A future thread needs effective notify empty and reload-safe enforcement. `notify=[]` replaces an array, whereas `mcp_servers={}` does not clear a table. |
| Profile and optional tools | Requested profile arguments are not proof of effective selection. Reconcile profile constraints, exact path/network policy, apps and web-search restrictions. Metadata observations cannot substitute for behavior probes. |

### Freshness and the bootstrap gap

`features list` loads runtime auth/cloud policy and has no exact named-profile/strict-mode equivalence. It does not expose all browser, remote-control, MCP, hook or policy provenance. It is a possible separate preflight with its own approved effects, not an offline operation or a complete authority certificate.

Local file hashes and configuration origin/version observations help detect drift, but cannot freeze cloud policy. No expected-config-version guard or complete MCP allowlist exists in `ThreadStartParams`. Repeating a read, imposing a short timestamp expiry, or discovering IDs then disabling them does not eliminate the race.

An early-control certificate needs a supported enforcement or stability argument for the actual startup load, not merely a preceding observation. If that argument is unavailable, the correct result is `PRELAUNCH_AUTHORITY_UNPROVEN` and zero app-server launches. The current packet has no such certificate. A successful metadata session also cannot be reused to authorize a later process or thread.

## Exact stop before thread/start

The future exchange owns a closed protocol capability, not a `ProviderSession`. Its external result contains only a safe evidence report and shutdown outcome. It exposes no `request`, raw `send`, `OwnedExecution`, resumable session, worker permit or callback that can continue into a thread.

One positive metadata exchange has this sole allowed outbound sequence, serialized with one request pending at a time:

| Order | Message | Constraint |
| --- | --- | --- |
| 1 | `initialize` | Fixed reviewed client identity/capabilities from the generated protocol; no caller-supplied arbitrary fields. Runtime-validate the response and Windows identity. |
| 2 | `initialized` | Exactly the generated notification shape, once, after initialization succeeds. |
| 3 | `config/read` | Exactly `{includeLayers:false, cwd:<sealed workspace>}`; wait for the correlated response. |
| 4 | `configRequirements/read` | Generated parameterless request; no `params` property; wait for its correlated response. |
| Terminal | Fence and drain | No further child protocol writes, even if every observed control is favorable. |

Enforce the allowed method, envelope, params, identity, order and count at the **sole outbound writer before any bytes are written**. A TypeScript union or wrapper around unrestricted `send()` is insufficient. Recheck terminal state when queued writes execute so timeout/cancellation cannot release delayed bytes. Validate a whole bounded message before splitting it into the helper's bounded input chunks.

`thread/start`, `thread/resume`, all turns, account/login/refresh, model catalog, config writes, command execution, tool/MCP status/discovery, remote-control and unknown methods are all forbidden. There is no successful-path exception. A server request receives no capability-granting response: immediately fence and drain. Any unsolicited notification or uncorrelated/duplicate/invalid response fails this deliberately narrow candidate; do not silently widen the accepted notification set to make a live run pass.

State sequence: `UNAUTHORIZED -> PREFLIGHT_ACCEPTED -> OWNED_PROCESS -> INITIALIZED -> CONFIG_OBSERVED -> REQUIREMENTS_OBSERVED -> FENCED -> DRAINED`. Any failure after launch goes to `FENCED`; any failure before launch records a no-launch refusal. There is no thread state or transition. Losing the controller/helper or encountering incomplete cleanup preserves an unresolved outcome; no automatic replay.

Ownership capture must precede protocol dispatch and show assignment before resume. Closing the transport only stops local parsing; it is not shutdown evidence. Keep output observation active through process drainage, validate any final framing, require root exit, zero owned Job membership, complete output and matching root/helper/owner identities. Record an incomplete drain as `DRAINING`/recovery required, never success. This remains Job-scoped evidence, not proof of complete brokered execution inventory or the five cancellation probes.

## Budgets, evidence and privacy

Proposed per-invocation limits, to be recorded as explicit qualification overrides in a later manifest: one process, no restart; three requests and one notification; one pending request; 5 seconds per response; 30 seconds active startup/inspection; 5 seconds graceful drainage plus at most 15 further seconds for evidence, for a 50-second total controller window. Use the existing 2-second renewal/10-second lease, 1 MiB frame/queued-input bound and 10 MiB total stdout+stderr bound counted before redaction. Finite deadlines apply to ownership, writes and shutdown as well as RPC responses. Any future strict negative case is a separate sealed invocation, not a retry within this exchange.

Count raw bytes in bounded memory, parse only schema-validated fields and persist only allowlisted projections. `includeLayers:false` does not redact effective config. Never persist raw configuration/requirements responses, raw stderr, arbitrary RPC errors, provider definitions, URLs, headers, environment values, token material, instruction bodies or raw layer/source identifiers. Avoid exception messages that embed parse input. Native/runtime-owned logging effects must be disclosed and scoped separately; this document does not claim the harness controls all runtime-internal logging.

Safe evidence includes request/action/owner identities, pinned input hashes, method/sequence/response correlation, byte counts, fixed failure codes, known booleans/enums, missing-versus-null distinctions, sanitized provenance categories/version observations and projection hashes. Preserve relevant origin consistency without emitting private paths or arbitrary names. Effective MCP server identifiers, if needed for a later design, must be validated and retained privately in controller-protected evidence; public summaries contain counts/states only and no transport/auth fields. Unsupported identifiers stop projection rather than bypass escaping rules.

Record separate fields for prelaunch authority, observations, protocol-boundary enforcement and process drainage. Do not label a metadata receipt `qualified`, claim subscription success, or award `worker.unapproved_config_inactive` from configuration values alone. Existing five blockers and 30 untested probes remain unless their own scoped evidence requirements are later met. Target/source changes invalidate affected receipts; preserve the original two-probe result without copying its PASS entries to a new target.

## Alternatives and implementation scope

**Rejected: reuse `ProviderAdapter.start/resume` and stop before `turn/start`.** This creates a thread before stopping, can activate session MCP/hooks and exposes broad authority. The existing observed-authority callback occurs too late for this purpose.

**Selected: independent metadata exchange with a hard runtime writer gate and external pre-process evidence.** It reuses bounded framing and ownership mechanics while keeping worker authorization separate. It can be tested offline even though no actual app-server launch is presently admissible.

**Separate path: expand verifier write-denial coverage.** This is still a reasonable later qualification batch, but does not solve startup authority. Its existing approval/seal cannot authorize this startup work.

If implementation is later approved, the smallest useful first scope is an **offline-only control core**, without a live CLI entry point:

| Proposed file / responsibility | Scope |
| --- | --- |
| `src/qualification/codex-startup-authority.ts` (new) | Strict evidence/phase schemas and pure refusal/comparison logic. Unknown sources/fields/phase scope cannot produce launch permission. No new database or credential inspector. |
| `src/providers/codex/startup-metadata.ts` (new) | Closed finite exchange, dedicated secret-free projections, ownership/drain result; no worker/session API. It accepts only the internally bound authority/input contract and owns the transport lifecycle. |
| `src/providers/codex/transport.ts` (limited change) | Runtime metadata mode enforced at the outbound writer, exact sequence/shape validation and fence-aware queued sends. The existing worker mode must retain its behavior; no general transport refactor. |
| `tests/codex-startup-authority.test.ts`, `tests/codex-startup-metadata.test.ts` (new) | Deterministic fake ownership/protocol tests, with no real runtime or network effects. |

Do not modify worker `adapter.ts`, relax `policy.ts`, change generated protocol files, clear `probes.ts` blockers, add a ledger migration or alter supervisor enforcement in that first scope. A later live orchestrator/dry-run seal/CLI integration is a separate review after early-authority feasibility is resolved. A later worker adapter correction or evidence-based full blocker-clearance mechanism is also separate; the core must not silently make either change.

Planned verification families, **not executed or authorized by this document**:

- Missing/conflicting/stale/wrong-target authority refuses with zero launches; observed metadata cannot substitute for a pre-process prerequisite; absent, null and disabled policy are distinct.
- Capture exactly the four outbound messages; direct and indirect forbidden sends, reordered calls, duplicate initialization, malformed envelopes and queued sends after fence write zero forbidden bytes.
- Unexpected server requests/notifications, invalid UTF-8, correlation errors, truncated/oversized output, timeouts and ownership mismatch fence and drain once; incomplete cleanup never becomes success or replay.
- Hostile secret-bearing configuration/requirements/provenance/error inputs cannot escape through evidence, logs or exceptions; missing managed surfaces remain unknown; table merge and MCP reload counterexamples stay blocked.
- Static checking and affected transport/adapter regression checks once after the approved code change; retain unaffected passes. Any stale existing check needs the repository's narrow revalidation authorization. Do not rerun aggregate suites.

An independent reviewer must assess the actual future code and tests before any dry run or launch. After two unsuccessful corrective candidates, stop and return the evidence. No live retry is bundled into an implementation approval.

## Exit from this design task

Deliver this document, an independent review and any design corrections. Report the exact unresolved early controls and the restricted implementation scope. Stop before implementation, tests, new seals or live operations. The current feasibility decision is **offline core feasible; app-server launch blocked on pre-process authority; worker qualification still incomplete**.
