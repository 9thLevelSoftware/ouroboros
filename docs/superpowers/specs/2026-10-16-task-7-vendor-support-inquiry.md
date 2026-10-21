# Draft: supported policy-bound Codex startup on Windows

> WITHDRAWN / NOT SENT, 2026-10-16. Retained as historical drafting evidence only. The [corrected design](2026-10-16-task-7-documented-integration-design.md) uses documented OAuth/app-server integration and retires this inquiry's stronger contract as a Task 7 prerequisite. No vendor response is required for the planned offline integration. This text must not be sent as the current project request; any future inquiry needs its own concrete gap and separate sending authorization.

Status: prepared for review; NOT SENT. This draft contains no credentials, account identifiers, host configuration, private fixture paths, or live payloads. Its existence grants no runtime authority.

We are integrating the official Codex runtime into a Windows controller using runtime-managed ChatGPT subscription authentication. We need a supported way to authorize a bounded startup using the complete applicable policy before protected startup effects occur. Our reviewed baseline is 0.162.1; a focused source review of official 0.163.0 (commit `83086188ae0614bd882818ff1aa23f3194962012`) did not establish such a public contract. This is a scoped evidence gap, not a claim that no supported solution exists.

Could you identify a supported official interface and release, or confirm the limitation, for the following requirements?

1. **Policy resolution and binding:** resolve applicable ordinary and managed/cloud policy with actual precedence, account/workspace/cwd scope, and a complete effective inventory; bind that result to the process startup rather than a later metadata reload.
2. **Preparation and effects:** provide an independently restricted preparation/entry path, with explicit permitted auth/policy network operations, cache or credential writes, state-database operations, installation-identity operations, and cleanup. We need enforceable finite counts that include retries and auth recovery; a timeout alone is insufficient.
3. **Enforcement before activation:** cover remote control before initialize client-name processing, plugins and their contributions, browser/computer paths, hooks and legacy notifications, ordinary/plugin MCP, apps, and provider/environment startup. Metadata-only operation must not create threads, make model requests, or activate these surfaces.
4. **Validity and recovery:** document authoritative snapshot validity or revision admission, changes/revocation and disconnect handling, exclusive consumption, crash/unknown-outcome reconciliation, and safe sanitized receipts. Local hashes, timestamps, or cache integrity do not by themselves establish this authority.
5. **Separate purposes:** identify how worker/thread admission and the independent Windows verifier enforce their own complete policy bindings. A terminal metadata inspection must not be upgraded into permission for worker execution or later MCP reloads.
6. **Windows applicability:** identify supported OS/build requirements, exact official executable and dependencies, source/build correspondence, supported direct-stdio/permission-profile arguments, and any restrictions particular to MXC or managed policy delivery.

The inspected public configuration methods are postlaunch reads, and startup loads auth/policy before those reads. We therefore cannot treat a successful metadata response as authorization for earlier effects. We will retain a blocked state rather than patch the runtime, skip managed sources, or manufacture an authorization certificate.

An answer should name supported mechanisms, enforcement points, platform/version applicability, limitations, and evidence needed for qualification. A documented alternative is useful, but a pre-activation design would need a separate review and must account for effects before policy resolution.

References:

- [Official 0.163.0 release](https://github.com/openai/codex/releases/tag/rust-v0.163.0)
- [CLI app-server arguments](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/cli/src/main.rs#L571)
- [Startup configuration/auth loading](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/lib.rs#L531)
- [Configuration read interfaces](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server-protocol/src/protocol/v2/config.rs#L389)
- [Managed-configuration documentation](https://learn.chatgpt.com/docs/enterprise/managed-configuration)
