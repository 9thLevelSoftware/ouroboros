# Ouroboros

Ouroboros runs a scoped engineering task in a separate workspace, checks the result with a fixed verification command, and exports a patch for review. The source repository is not changed automatically.

## Run a task

Use Windows, Node >=24, a prepared native supervisor release helper, and the user's normal Codex sign-in. Development selects Node 24; compatible newer Node versions require the same runtime capabilities and a working native SQLite binding. The runner records the observed executable versions and SHA-256 identities for each run and checks startup compatibility before dispatch. Unsupported or unsafe runtime behavior fails closed. From the repository root:

```powershell
node --experimental-strip-types src/cli/main.ts run --task-file 'D:\tasks\task.json' --json
```

The task file is JSON, limited to 64 KiB, and rejects unknown fields. Example:

```json
{
  "schemaVersion": 1,
  "repository": "D:\\work\\sample",
  "task": "Fix the parsing bug in src/parser.ts and add a regression test.",
  "model": "gpt-6.1-sol",
  "effort": "medium",
  "allowedPaths": ["src/parser.ts", "tests/parser.test.ts"],
  "protectedPaths": [],
  "verification": {
    "executable": "C:\\tools\\node.exe",
    "argv": ["--test", "tests/parser.test.mjs"],
    "inputs": ["tests/parser.test.mjs"],
    "timeoutMs": 60000
  },
  "timeoutMs": 300000,
  "maxSnapshotBytes": 67108864
}
```

Required fields are `schemaVersion`, absolute `repository`, `task`, `model`, `allowedPaths`, and `verification` (`executable` must be absolute; `argv` is the fixed argument array). Optional fields are `effort` (`low`, `medium`, `high`, `xhigh`, `max`, or `ultra`), `protectedPaths`, `verification.inputs`, `verification.timeoutMs` (up to five minutes), overall `timeoutMs` (10 seconds to 30 minutes), `maxSnapshotBytes` (up to 1 GiB), and absolute `runtimePath` / `helperPath` overrides.

`allowedPaths` and `protectedPaths` use repository-relative literal file paths or directory prefixes. Globs are not supported. The snapshot contains Git-tracked and non-ignored untracked files from the repository root; ignored files are excluded. Unsafe paths, links and credential-like paths are refused. The runner automatically protects only a plain Node entry script named as `argv[0]`; it does not infer script inputs from later arguments. Checks selected through discovery, globs, or configuration require explicit `verification.inputs`. A leading fixed Node `--eval`/`-e` or syntax-check `--check`/`-c` invocation may omit inputs. Explicit inputs are protected against changes in the candidate. Keep the verification executable and its dependencies outside the worker-writable workspace, and specify every repository input whose integrity matters.

The controller creates a fresh run directory under `%LOCALAPPDATA%\Ouroboros\workspaces` and keeps task reports and evidence under `%LOCALAPPDATA%\Ouroboros\tasks`. It compares the source repository with the initial snapshot and refuses a result if the source changed. The worker edits only the copied workspace. The controller then runs the supplied verifier with the workspace read-only, checks the candidate against the literal allowed/protected paths, and exports a patch. It never applies that patch to the source checkout.

Exit code `0` and status `READY_FOR_REVIEW` mean the independent verifier completed successfully, cleanup/evidence checks passed, and a patch is available for review. Other statuses are not a successful result. Read the JSON report at its `reportPath`; it includes the status, changed files, evidence IDs, source-preservation result, and patch location when ready. Review the patch before applying it. The report gives `applyStrip: 2`; from the repository root, use `git apply -p2 <patch-file>` only after review.

Each provider transport has a 256 KiB output limit. Ctrl+C or a termination signal requests cancellation. The controller attempts to stop and drain owned processes; if cleanup cannot be confirmed, the report carries a recovery status and no ready patch. A crash can leave retained execution ownership that needs explicit reconciliation; a controller recovery command is not yet exposed.

## Scope and qualification

The current `run` command implements native Windows Codex task execution and defaults to `native/supervisor/target/release/ouroboros-supervisor.exe`. It records and rechecks runtime/helper/Node identity, the user-config fingerprint, and observed effective-policy settings before dispatch; this does not establish a complete freeze of every policy source. Compatibility depends on observed app-server startup capabilities and safe effective policy, rather than an exact release allowlist. The current task runner does not implement Claude or WSL task execution. The installed Codex `0.163.0` has not yet been accepted by a live run or qualification campaign.

The native Windows task path completed a live functional test on 17 October 2026: run `07120738-56ea-4a6b-ab88-7ffe6a6d7368` fixed an arithmetic defect in the copied workspace, passed the protected verifier, exported the expected patch and reached `READY_FOR_REVIEW` in 83.1 seconds. The original source remained unchanged and all owned processes drained. Startup now consumes the actual initial thread response and the server's disabled remote-control status report; authorization compares schema-normalized launch values. The task's wall-clock deadline is separate from the finite allowance for summed root/helper process time. Earlier unsuccessful runs remain retained evidence. This test establishes the functional path on that historical installation; broader qualification remains separate.

Ordinary task execution and provider qualification are separate. A successful task creates no qualification receipt. Task 7 retains five open startup decisions and 0 of 32 accepted probes. Its qualification campaign remains incomplete until its own evidence is accepted; stop at a failed required capability and require fresh authorization before another live qualification retry.

`doctor --qualification-status <campaign-id>` reads an existing campaign and reports its five evidence-backed decisions, supporting requirements, 32 probe results and retained usage. The optional `--accepted-reviews <reviews.json>` supplies explicit independent-review artifact references and their accepted hashes. The report describes the recorded target; it does not revalidate the installed runtime or grant execution permission. Missing, stale or unaccepted evidence keeps the relevant decision open.

`doctor --qualify-campaign --plan-file <path> --unit <id>` displays one bounded unit from a prepared campaign plan. The execution path requires `--approve-plan <displayed-hash>` and an existing current campaign owner. It runs metadata, the strict pair, or a named probe through the native qualification runner. It checks the current grant, exact launches, pinned inputs and remaining allowance, then stops on failure. A successful unit alone does not close a startup blocker. The external controller records its complete process/output accounting before selecting the next unit.

## Development

```powershell
npm run build
npm run typecheck
npm test
npm run dev -- doctor [--json]
```

The test script excludes `tests/live/**`. The Rust helper is in `native/supervisor` and uses Rust stable. npm and Cargo manifests express compatible dependency ranges; checked-in lockfiles remain reproducible resolved snapshots. If Node is too old, lacks a required capability, or cannot load the native SQLite binding, startup fails with a capability/native-rebuild error; prepare or rebuild native dependencies explicitly for the selected Node runtime. Ordinary task runs never install/update dependencies or generate schemas. See [CLAUDE.md](CLAUDE.md) for repository architecture, qualification commands, and implementation notes.

Protocol generation is an explicit development operation: `scripts/generate-codex-protocol.ps1 -CodexExecutable <absolute-executable> -OutputRoot <absolute-parent>` observes the supplied executable version and SHA-256 and writes beneath `<version>-<sha256>`. Prepared imports require a manifest with matching `runtimeVersion` and `binarySha256`, plus the existing per-file byte/hash records. Existing generated protocol artifacts remain historical snapshots and must not be overwritten or hand-edited.
