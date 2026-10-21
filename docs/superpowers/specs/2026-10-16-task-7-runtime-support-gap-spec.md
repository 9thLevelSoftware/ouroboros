# Task 7: runtime-support gaps for binding effective policy to startup

> Historical stronger contract, superseded 2026-10-16 by the [documented-integration design](2026-10-16-task-7-documented-integration-design.md) and [corrected Task 7 plan](../plans/2026-10-16-task-7-blocker-resolution.md). The prepare/consume issuer, complete pre-process policy binding, leases and per-effect counters below are additional guarantees, not prerequisites of documented OAuth/app-server integration. They are no longer the active Task 7 acceptance contract. Preserve this specification and its review as historical evidence; practical restrictions and all five open blockers are governed by the corrected design. No implementation or live run is authorized here.

Date: 2026-10-16. Status: requirements specification; independent review recorded separately. This document requests runtime guarantees that have not been established. It is not an implementation plan, a policy certificate, a launch manifest, or permission to collect live evidence.

## 1. Purpose and current decision

Provide a testable contract for proving that a narrowly authorized metadata startup uses the effective policy that was approved for it, and that the runtime enforces that policy before any protected effect. Cover preparation, process admission, initialization, policy changes, cleanup, and the effects needed to obtain policy.

The user authorized this specification and independent review only. All five startup blockers remain OPEN, and PRELAUNCH_AUTHORITY_UNPROVEN remains the current decision. No implementation, new seal, live run, configuration/credential/database inspection, external support message, or test execution is authorized by this document.

The preferred support direction is a **runtime-enforced prepare/consume contract**. A trusted preparation component resolves applicable policy; a trusted consumer binds the actual startup to that result and enforces it before activation. Both ends and their bootstrap effects need independent justification. A controller-generated signature or a recent observation does not supply those guarantees.

The accepted audit found no complete public pre-process handoff in pinned Codex0.162.1 source at commit092d3acd6bec3e3a14bdc7e7a2810ab628ab759d. This does not establish impossibility or identify a supported future version. The current offline core consumes an already-owned execution and always refuses actual startup authority; it is not the issuer proposed here.

## 2. Evidence basis and support gaps

The following are retained, independently accepted source conclusions, not current host observations. Full source citations/fingerprints are in the audit documents linked at the end.

| Gap | Established boundary | Required additional runtime support |
| --- | --- | --- |
| G1: complete policy binding | System requirements can be overridden by cloud scalar values; ordinary cloud config is separate; managed feature pins apply after ordinary values. | Complete applicable resolution and a supported immutable or atomically validated binding used by the actual startup. |
| G2: early remote activation | initialize client-name processing can resolve saved enablement before normal RPC processing. Effective requirements false disables the same-load remote controller. | That effective denial must already be proven and enforced before client-name processing; status Disabled is not proof of saved disablement. |
| G3: browser/computer enforcement | Master policy is parsed/projected; native enforcement consumer/timing was not established. | Identify every applicable activation path and demonstrate denial before resource acquisition or external activity. |
| G4: bootstrap effects | Startup can load/refresh auth and policy, persist cache, initialize/migrate SQLite, log, and create/repair installation identity before metadata inspection. | A supported restricted preparation/entry path with explicit effect-level enforcement and separate human/machine authority. |
| G5: stability and recovery | Metadata reads are separate loads; internal cloud guards have narrower scopes; cache integrity/TTL do not freeze policy. | Authoritative admission/revocation semantics, exclusive consumption, reload control, and crash reconciliation. |
| G6: supported integration | Direct app-server rejects root named --profile; current metadata core has no launch-authority issuer. | Document actual supported interfaces, argument semantics, trust/protocol versions, and startup receipt transport. Do not invent flags or widen the metadata writer. |

Named user-configuration --profile is distinct from the permission profile selected by default_permissions. A future support response must distinguish them and retain applicable managed restrictions. No runnable arguments are specified here.

## 3. Authority, trust and alternatives

**R1 — Intersection of authorities.** Every operation requires both the applicable machine policy and explicit human authorization for purpose, resources, effects, attempts and stopping condition. Human approval never overrides managed policy. Machine policy allowing a surface does not require this metadata operation to activate it. A mandatory setting incompatible with the restricted operation causes refusal.

**R2 — Trusted preparation and consumption.** The issuer must be a runtime/vendor component or separately qualified broker with demonstrated authority to resolve all applicable policy. Its code identity, trust anchor, authenticated caller, protected state, version and failure behavior must be explicit. The runtime consumer must enforce the binding before protected startup effects. Signing is an optional integrity mechanism, not proof of policy authority; an authenticated broker-held opaque handle is also acceptable. None of these new interfaces is asserted to exist today.

Three approaches were considered:

| Approach | Decision/tradeoff |
| --- | --- |
| Separately authorized preparation plus runtime-enforced consumption | Preferred requirements target. Can support genuine pre-process authority if issuer, validity and the consumer's fail-closed entry guarantee are proven. Requires support beyond an external wrapper. |
| Runtime starts under independently authorized restrictive bootstrap, then resolves policy before activation | Possible separate pre-activation design. It cannot retroactively justify process creation or its bootstrap effects. Requires a separately proven initial envelope and must never be labeled pre-process evidence for that same process. No automatic fallback to it. |
| Repeated feature/config reads, local overrides, cache export, private marker/SQL convention, controller-only signed claim | Insufficient. These do not close applicability, early-effects, policy-update and consumption races. |

If the preferred contract cannot be substantiated, the outcome is a documented support gap and zero app-server launches. Further source/design clarification is allowed only as separately scoped work; no unsupported API may be simulated into authority.

## 4. Preparation without circular authorization

**R3 — Independent preparation envelope.** Before policy resolution begins, the preparation component must have an independently enforceable envelope derived from already applicable bootstrap constraints plus the human-approved operation. It must be safe even while later ordinary/managed/cloud values are unknown. Treat input configuration as data; parsing cannot activate plugins, command-backed auth, helpers, instructions, remote control, tools, model traffic or unrestricted environment setup.

A permitted policy/auth destination, credential source or write cannot be justified solely by policy fetched through that same effect. If its permissibility cannot be established beforehand, preparation refuses. No isolated home, omitted cloud loader, skipped managed source or weaker sandbox may be used to manufacture a favorable result.

The preparation operation itself may involve a process and effects. Those require their own prior authority; a future app-server binding does not authorize them. If only a process-free trusted service can satisfy the needed bootstrap boundary, that support must be demonstrated. No such service or collector is assumed here.

The preparation output describes whether all required fields and sources are known, applicable and compatible. UNKNOWN, CONFLICT, unsupported provenance, incomplete ordinary/cloud requirements or failed collection yields refusal. Empty/null/ineligible-cache results must retain their exact limited meanings, not become blanket absence claims.

## 5. Bound data and policy validity

**R4 — Complete bound intent.** A prepared result must bind these dimensions through authenticated, integrity-protected state:

- Issuer/consumer/controller identity, supported runtime executable identity, relevant load dependencies/trusted loader boundary and build correspondence, protocol/schema version, controller policy version, and purpose METADATA_STARTUP_ONLY.
- Human authorization reference, intended owner/action/generation, nonce, single-consumption identity and authorized attempt ceiling.
- Exact executable arguments, cwd and canonical configuration ancestry, permission profile and sandbox boundary, supported loader selection, environment construction, and provider/login/account/workspace applicability.
- Complete ordinary configuration and managed/cloud requirements: ordered sources, provenance, applicability, revisions, effective restrictions, profile selection/fallback and all inputs that affect early startup.
- Fixed client identity and direct-stdio mode, allowed protocol sequence, exact effect envelope, deadlines/resource counters, policy-validity mode, revocation semantics and permitted terminal transition.

Credentials remain runtime-managed. Export only allowlisted safe projections and opaque scope references; keep full configuration, private paths/identities, raw responses, credential material and secret-derived commitments inside protected runtime/broker state. Public hashes are limited to reviewed nonsecret projections. The controller must be able to verify completeness and compatibility without receiving raw secrets.

Pre-process binding identifies intended execution, not nonexistent PIDs. Actual process creation identity, helper and Job ownership are established after creation and before resume/protocol dispatch, using trusted launcher receipts. They must match the reserved intent. The current inspection plan's actual-execution fields cannot be repurposed as a pre-creation certificate.

**R5 — Consume the same policy.** Consumption must either use prepared immutable inputs under an authoritative validity contract, or atomically validate current inputs and reject any difference before protected effects. File hashes checked earlier are insufficient if files can change before use. No silent reload, substituted profile, default fallback, changed account or approximately equivalent configuration is permitted. Resolve real precedence; do not overwrite a higher-precedence managed value merely to make it safe.

A support response must select and substantiate exactly one policy-validity mode; neither is presently established:

1. **Authoritative snapshot lease:** the actual policy authority explicitly permits the specified snapshot for the stated scope/interval and declares revocation behavior. The runtime enforces expiry and any required revocation throughout the operation.
2. **Authoritative revision admission:** the protected transition has an authoritative ordering with updates/revocation, and all subsequent effects are covered by documented invalidation semantics.

A local TTL, cache HMAC, timestamp or repeated read supplies neither mode. Required revocation latency, disconnect behavior and permissible in-flight effects must be explicit and machine-authorized before any operation; missing values refuse. If immediate revocation is required, disconnected cached use is inadmissible. A deadline cannot undo completed effects.

Policy tightening or revocation must fence new effects and initiate cancellation/drainage within the approved semantics. A change requiring a different grant cannot silently upgrade the active binding. If no supported ordering or validity guarantee can be demonstrated, consumption remains unavailable.

## 6. Admission, consumption and crash semantics

**R6 — Exclusive, durable use.** Conceptual states below are requirements, not new implemented APIs:

1. UNAUTHORIZED: no preparation/startup action.
2. PREPARATION_AUTHORIZED: only independently approved preparation effects.
3. PREPARED: complete policy/effect binding; not worker authority.
4. RESERVED: controller validates trusted issuance, applicability, human scope and validity; trusted issuer/consumer mechanism exclusively reserves one activation before target process creation.
5. OWNED_ENTRY: launcher creates the exact target under required ownership before resume; only a demonstrably inert, fail-closed validation entry may run before consumption.
6. CONSUMED_METADATA_ONLY: runtime atomically consumes the binding before any protected startup effect, retaining policy/effect enforcement through initialization and metadata.
7. FENCED -> DRAINED, or UNRESOLVED requiring reconciliation. No thread transition.

Pre-process permission to create OWNED_ENTRY depends on proof that its pinned entry cannot perform unapproved effects before consumption. If that guarantee is absent, do not create it. A post-startup success receipt cannot repair missing initial authority.

The entry's validation work must itself be covered by the independent initial envelope: only bounded validation of the binding and any explicitly approved local trusted-broker control channel. It may not perform policy/auth network fetches, general configuration reloads, credential/database writes or other target-startup effects to learn whether it was allowed to run. If consumption needs such work, complete it in the separately authorized preparation component or refuse this pre-process design. A protected validation channel is a required support surface, not an existing API asserted here.

Reservation/consumption must be exclusive across processes and durable before first protected activation. A nonce without an enforcing registry or equivalent primitive is insufficient. Prevent replay across process restarts, changed owner generations and concurrent consumers.

A crash after reservation, lost acknowledgement or uncertain dispatch yields UNKNOWN_OUTCOME: no automatic replay, reseal or new process. Keep the binding spent/fenced pending reconciliation. Idempotent receipt retrieval may recover evidence; it must not start another execution. A later attempt requires fresh authority within the still-applicable human attempt ceiling. Do not promise exactly-once process creation across arbitrary crashes.

A runtime-origin binding-consumption receipt must be verifiable through a supported trusted startup evidence channel before protocol dispatch; its mechanism and ownership association require support documentation and future integration review. It is not a new permissive metadata RPC. Any startup schema/transport changes remain separate implementation scope.

## 7. Enforcement at the actual effects

**R7 — Gates precede activation.** The runtime must demonstrate enforcement before each effect, including effects outside the JSON-RPC writer.

| Surface | Required enforcement |
| --- | --- |
| Remote control | Same-load effective prohibition checked before initialize client-name processing, persisted-state resolution that could enable it, enrollment, connection, daemon or pairing activity. No reliance on initial connection status or omitted CLI flag. |
| Plugins | Enforce final effective disablement before synchronization, warmups, plugin executors or contributions. Conflicting mandatory managed pins refuse; no local precedence bypass. |
| Browser/computer | Identify and cover all native/external/extension/CDP activation paths and their consumers before resource acquisition. Schema exposure or a false projection alone is not evidence. Unknown path coverage refuses. |
| Hooks/notify/MCP/apps/tools | No hook/notify execution, MCP discovery/status/auth/connection, app execution or other tool activation in preparation or metadata startup. Preserve separation of hooks from legacy notify. Any previously assumed dormant path must have source and eventual behavior evidence. |
| Provider/environment | No model request, command auth, arbitrary environment setup, workload identity, API fallback, provider/account switching or unapproved helper/child execution. Runtime-managed subscription auth is a separate conditional effect below. |
| Configuration changes | No config/policy/persisted-preference mutation to force a passing state. Reload may preserve the exact binding or refuse before activating a changed surface. |

The sole metadata writer remains exactly initialize, initialized, config/read with includeLayers:false and bound cwd, then parameterless configRequirements/read, followed by fence/drain. No thread/start/resume, turn, account/login RPC, remote status, tool/MCP operation or generic sender/worker handle is exposed. Postlaunch observations are cross-checks, not prelaunch authority.

No successful result may upgrade purpose or continue into a thread. The later worker/MCP reload problem requires separate authority and qualification even if metadata startup eventually becomes admissible.

## 8. Permitted-effects contract

**R8 — Deny by default; exact approval before use.** The table specifies candidate effect classes a future supported mode may request. It grants none now. Every requested class needs independent machine-policy permission, explicit human coverage and runtime enforcement. Omission means forbidden. Preparation and target-startup budgets/permissions are separate; success in one phase does not authorize another.

| Effect class | Potentially requestable narrow permission | Required refusal/limitation |
| --- | --- | --- |
| Configuration/policy inputs | Read exact approved local ancestry and authoritative policy sources; parse as data. | Unknown source/applicability, unbounded discovery, substituted loader or executable configuration refuses. Do not skip applicable managed/cloud sources. |
| Runtime-managed auth | Read the approved existing credential source for the bound account; use explicitly allowed refresh/recovery route. | No token export/copy, login flow, account switch, command auth, API fallback, workload identity or inherited credential selection. Unexpected identity change invalidates preparation/binding. |
| Policy/auth network | Exact approved service identities/destinations, methods, proxy/TLS constraints and bounded responses. | Count every request, redirect, recovery exchange and retry before dispatch; unapproved redirect/destination or budget exhaustion refuses. No model, MCP, browser, remote-control or telemetry traffic. |
| Credential/cache persistence | Only explicit runtime-owned store entries and mutation classes for the approved account/policy cache, bounded in bytes and operations. | Not implied by a read grant. No unrelated stores, bulk copies or rollback/erasure of user data. Failed or uncertain mutation is recorded; no blind retry. |
| State database | A supported metadata mode may request exact database read/open permissions. Creation, migration, backfill, corruption backup, rebuild and repair are distinct grants. | Default design envelope prohibits schema changes, repair/recovery and backups. If current startup requires them, it must refuse or obtain a separate reviewed expanded effect authorization; no silent fallback or destructive cleanup. |
| Installation identity | Read the exact approved identity file. Creation of a missing file is a separately declared candidate grant. | Replacement/repair of an existing invalid identity is forbidden in the baseline envelope; do not inherit it from create/read permission. |
| Processes and local resources | Exact qualified preparation component, one reserved metadata target and named ownership/helper mechanism, with approved process/file/socket limits. | No model/worker/daemon/background child creation or unowned/brokered escape. Unknown or extra execution remains unresolved and blocks continuation. |
| Logging/diagnostics | Bounded sanitized records in exact approved runtime/controller destinations. | No raw config, tokens, instruction bodies, URLs/headers, arbitrary error bodies or unrestricted telemetry. Internal runtime logs must be covered too; harness redaction alone is insufficient. |

A request must instantiate finite numeric ceilings for wall time, actual network requests, redirects/auth recoveries, bytes read/written, files/handles, process counts, output and cleanup. Reject missing, infinite, unsupported or unenforceable limits before effects. The specification does not invent host destinations, stores or grants; their exact values are required in a separately reviewed future request.

Counters must be enforced at the relevant boundary, not inferred from elapsed time. In particular, the pinned cloud loader's five retry-counter positions permit same-position retries after auth recovery; they are not a hard HTTP request cap. Multi-phase accounting must prevent a retry, recovery or new phase from resetting a shared limit without new authority. Completed effects stay recorded even when a later step fails.

Retain the existing metadata design's candidate bounds: one target, no restart; three requests/one notification, one pending request; response5s, active30s, fence grace5s, further drain/evidence15s, total50s; renewal2s/declared lease10s; frame/queued-input1MiB, raw output10MiB. These are already scoped offline-core limits, not qualification of the future preparation or runtime enforcement. Preparation needs its own explicit finite limits; it cannot borrow a metadata deadline to authorize effects.

## 9. Evidence, cancellation and receipt semantics

**R9 — Evidence establishes scope, not permission by itself.** Preparation/admission receipts must expose safe completeness/compatibility results, issuer identity and integrity validation, opaque binding/policy scope, purpose, human authorization reference, owner/action/generation, validity mode, consumption state, observed control categories and remaining budgets. Runtime consumption evidence must bind actual executable/process creation identity to the reserved intent.

Record separately: machine-policy decision, human-effect authorization, intended launch binding, actual ownership, runtime enforcement activation, metadata observations, effect counts, policy changes, and fence/drain outcome. No raw configuration/credential-bearing commitment is exported to replace those records. Unsupported/missing fields must fail closed; only a proven trusted issuer may populate an authorizing result.

Cancellation, expiry, policy failure, ownership loss, unsolicited RPCs or budget exhaustion fence protocol and all new non-cleanup effects, then initiate bounded drainage. The initial authorization must reserve a separate finite cleanup allowance for stopping owned execution, closing resources and recording sanitized terminal evidence; cleanup cannot refresh auth/policy, retry startup, mutate configuration, erase user state or gain new capabilities. Keep output observation active; require matching owner/helper/Job scope, root exit, empty owned membership, complete bounded output and no unresolved execution. Incomplete cleanup is UNRESOLVED, not reusable success. Runtime-internal and brokered work must be accounted for; a Job receipt alone does not prove every external effect stopped.

This contract must not silently auto-clear global qualification blockers or copy earlier verifier passes to a changed target. A successful metadata receipt remains metadata-only and terminal.

## 10. Acceptance evidence required later, not executed here

**R10 — Counterexample-driven acceptance.** A future support claim must provide interface/guarantee documentation, executable/source/build identity linkage, identified enforcement points, and independent evidence for each requirement. Offline tests alone cannot prove live enforcement or current host policy. No test code, fixture or command is supplied or run now.

| Counterexample | Required result/evidence |
| --- | --- |
| Local/system deny, cloud allow or managed plugin enable | Resolve real precedence; refuse incompatible restricted startup before protected effect. |
| Ordinary cloud fragments omitted but requirements complete | Preparation refuses incomplete applicable input set. |
| Account/cwd/ancestry/profile/environment/file content changes after prepare | Reject before effects or demonstrate a valid immutable authoritative binding; no silent substitution. |
| Revocation/update races reservation, consumption or reload | Demonstrate the declared authoritative ordering/validity mode and fencing latency; no unsupported stale admission. |
| Concurrent consumers/replay/generation change/crash after reserve/lost receipt | At most one permitted activation, durable spent/fenced state, no automatic retry; reconcile ownership before a new attempt. |
| initialize arrives immediately, saved preference enabled, status initially Disabled | Remote prohibition is already enforced; no connection/enrollment triggered by client-name processing. |
| Browser field reports false but one activation consumer ignores it | Support/qualification fails; projection cannot substitute for enforcement. |
| Auth recovery repeats at the same retry-counter position | Aggregate actual-request/effect budget still enforced before the extra request. |
| Auth/cache effect required but not independently permitted | Refuse preparation before that effect, not after learning its policy. |
| Database migration/backup or installation-ID repair needed but omitted | Refuse before mutation; preserve prior state; no wider implicit grant. |
| RPC metadata load differs from prepared startup policy | Report conflict, fence/drain; never replace prepared authority with the later observation. |
| Reload adds an MCP server, hook, plugin, provider or changed mandatory restriction | No new activation under the old binding; require fresh authority or refuse. |
| Output/diagnostic contains secret-bearing payload or unknown execution survives cancellation | Privacy gate rejects/persists only safe failure; unresolved cleanup cannot be replayed or called complete. |
| Runtime accepts only a wrapper assertion or unverified signature | Refuse unsupported issuer/consumer mechanism; no policy authority inferred. |

Required evidence must distinguish zero protected effects on a refused pre-creation request from bounded, explicitly authorized preparation effects that occurred before a later refusal. Refusal must not be reported as side-effect-free if those approved effects happened.

## 11. Support response and implementation boundary

A useful runtime/vendor support response must answer each G1-G6 gap with a documented supported mechanism or explicit limitation:

- Name supported prepare/consume or restrictive-entry interfaces and platform/version applicability; do not propose private environment markers or database conventions as stable public contracts.
- Identify issuer trust, full policy source/applicability coverage, authoritative validity mode, revocation/disconnect semantics and cross-process consumption/recovery guarantees.
- Identify earliest enforcement consumers for remote control, plugins, browser/computer and all additional startup surfaces; account for initialization preceding normal RPC processing.
- Enumerate bootstrap and target effects separately, show where their exact counters/resources are enforced, and identify which current mandatory mutations can be suppressed.
- Specify protected binding/receipt transport without widening the metadata RPC capability, and show build correspondence and evidence needed for future validation.

Unknown/unsupported answers remain gaps; a bare assurance is insufficient. A supported mechanism would still require a separately approved design/implementation and focused offline validation, followed by independent review and separately authorized qualification. There is no automatic transition from accepting this document to coding, creating a seal or launching anything. No support request has been sent.

Expected implementation ownership, if ever approved, spans runtime issuer/consumer and effect gates, plus a separately reviewed Ouroboros integration. An external collector or CLI wrapper alone cannot supply runtime enforcement. No source files are assigned for changes by this specification.

## 12. Blockers, feasibility and stop

| Blocker | Status after this specification |
| --- | --- |
| PLUGIN_STARTUP_UNPROVEN | OPEN: actual applicable startup disablement/enforcement still unqualified. |
| BROWSER_COMPUTER_STARTUP_UNPROVEN | OPEN: enforcement consumers, timing and applicable restrictions still unproven. |
| MCP_INVENTORY_UNPROVEN | OPEN: complete ordinary/plugin inventory/suppression and later thread reload safety still unqualified. |
| MANAGED_REQUIREMENTS_UNVERIFIED | OPEN: actual complete effective policy and supported pre-process binding not established. |
| STRICT_CONFIG_RUNTIME_UNVERIFIED | OPEN: strict-specific accepted/rejected runtime evidence and exact negative case remain outstanding. |

Remote-control and provider/environment startup obligations remain additional gates. Feasibility is conditional: the contract identifies support that could close the gap, but no complete supported mechanism is currently established. The current outcome remains UNPROVEN with zero new launches.

Stop after this document, independent review and preservation records. No implementation plan, code/test changes, tests/builds, personal config/credential/database reads, new authority/seal, runtime/helper/provider/auth/sandbox action, thread/start, commit or push is part of this task.

## References and evidence status

- [Accepted offline source audit](D:/ouroboros/.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-startup-evidence-audit/report.md) and [independent review](D:/ouroboros/.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-startup-evidence-audit/independent-review.md):52pinned source blobs reviewed; host/binary/live applicability not established.
- [Remote-control trace](D:/ouroboros/.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-startup-evidence-audit/remote-control-audit.md): same-load denial, exact saved-state scope, initialization timing and state/identity effects.
- [Managed/cloud trace](D:/ouroboros/.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-startup-evidence-audit/managed-cloud-audit.md): precedence, cache/fallback/refresh, profile syntax, browser uncertainty and corrected retry-counter semantics.
- [Reviewed metadata design](D:/ouroboros/docs/superpowers/specs/2026-10-15-task-7-startup-authority-design.md) and [offline-core completion](D:/ouroboros/.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-startup-core-completion.md): existing closed writer/lifecycle scope; no issuer or live authority.
- Specification review/preservation records: D:/ouroboros/.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-runtime-support-gap-spec/.

No prior source audit or test result was rerun to produce this specification. Requirements above are proposed support obligations; they must not be read as verified runtime features.
