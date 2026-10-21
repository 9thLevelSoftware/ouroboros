# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## What this is

Ouroboros is a local engineering harness. The implemented `run` path uses the user's explicit task file to run native Windows Codex in an isolated copy, run a fixed independent verification command, and produce a reviewable patch. It does not commit, push, publish, or apply changes to the source checkout. Task execution is separate from the qualification ledger: a successful task run does not create a provider qualification receipt or close Task 7 blockers.

The broader design includes Codex app-server and Claude Agent SDK integration. The current `run` command supports native Windows Codex only; Claude and WSL task execution are not implemented by this entry point.

Authoritative documents (read the relevant section before changing behaviour):
- Design spec: `docs/superpowers/specs/2026-10-13-ouroboros-design.md`
- Implementation plan (historical task map and pins): `docs/superpowers/plans/2026-10-13-ouroboros-implementation.md`
- Execution ledger, review reports, snapshots and evidence: `.superpowers/sdd/` (use the current dated directory and `progress.md` rather than assuming the original plan is current).

## Commands

Run from `D:\ouroboros` on Windows with Node >=24; the development selector is Node 24. Each run records observed Node, Codex and helper executable versions/hashes and verifies their identities and startup compatibility before dispatch. Unsupported capabilities or unsafe effective policy fail closed. The default helper is `native/supervisor/target/release/ouroboros-supervisor.exe`. Node capability failures and unavailable native SQLite bindings require an explicit compatible runtime/native rebuild; ordinary runs never install or update dependencies or generate schemas. Installed Codex `0.163.0` is not yet live accepted.

```
npm run build
npm run typecheck
npm test
npx vitest run tests/store.test.ts
npx vitest run tests/codex-adapter.test.ts -t review1_
npm run dev -- doctor [--json]
npm run dev -- run --task-file D:\tasks\task.json --json
```

`run` accepts exactly `--task-file <absolute-or-relative-file-path> [--json]`. The JSON task itself requires an absolute repository path and has this shape (unknown properties are rejected):

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

`allowedPaths` and `protectedPaths` are repository-relative literal paths or directory prefixes; glob patterns are not supported. `verification.inputs` are added to the protected paths so a change to those inputs prevents a successful result. The verification executable must be an absolute path; its argument vector is supplied by the task file and is run independently with the worker workspace read-only. The verification command is fixed before implementation begins.

The controller snapshots Git-tracked and non-ignored untracked files from the repository root into a fresh sibling workspace under `%LOCALAPPDATA%\Ouroboros\workspaces`. It refuses ignored files, credential-like paths, links and unsafe paths. It checks the source against its initial manifest before accepting results; the source checkout is never automatically changed. Reports and controller evidence are stored under `%LOCALAPPDATA%\Ouroboros\tasks` (reports are in `reports\<run-id>.json`). A successful report points to a patch and gives `applyStrip: 2`; inspect the patch before applying it with `git apply -p2 <patch-file>` from the repository root.

Ctrl+C or process termination requests cancellation and drainage. A report status other than `READY_FOR_REVIEW` is not a successful patch. `NO_PROGRESS`, verification failure, stale inputs, or uncertain cleanup must be resolved from the retained report/evidence; do not claim success or retry automatically.

- `tests/live/**` is excluded by default. `doctor --qualify` and the verifier-slice command concern qualification, not ordinary user-task runs. Live qualification remains incomplete; user-task success is not qualification evidence.
- Rust supervisor: `native/supervisor` (Rust stable toolchain, compatible crate ranges and a reproducible Cargo.lock snapshot). Native tests may use the helper built at `native/supervisor/target/debug/ouroboros-supervisor.exe`; the task runner's default helper path is the release build.
- The Claude adapter under `adapters/claude/` and its WSL build are not used by `run`; do not infer that Claude or WSL is a supported task-run path.
- Codex protocol types under `src/providers/codex/protocol/0.162.1/` are historical artifacts. Explicit development generation with `scripts/generate-codex-protocol.ps1` records the supplied executable's observed version and SHA-256 in a runtime-specific output directory; prepared imports must provide matching runtime identity and per-file integrity metadata. Do not hand-edit generated files.

## Process rules

- Preserve work in progress. Do not commit, push, delete, reset, or modify source checkouts beyond the task's explicitly allowed scope.
- The user's explicit invocation of `run` authorizes that scoped task execution. Do not add a second approval ceremony for an ordinary user-task run. Runtime policy still denies permission escalation and keeps worker, verifier, protected inputs, and source checkout boundaries in force.
- Keep development/testing, ordinary user-task results, and provider qualification as distinct evidence. Do not convert a task result or source inspection into qualification evidence.
- Plan focused checks before editing and run each planned check once. Repeat a successful check only after a relevant change; after two different failed repair attempts, report evidence and escalate.
- Do not run live provider qualification or change host configuration/provider login unless the user explicitly asks for that work. `run` itself is a live user-task execution and requires the task file supplied by the user.

## Architecture

A Windows TypeScript controller owns task contracts, snapshots, verification, lifecycle, the SQLite store and reviewed knowledge. The native Codex app-server implements the requested task, a Rust helper supervises owned processes, and Codex sandbox settings constrain execution.

- `src/contracts/`: strict Zod schemas. Types are inferred from schemas, records carry versioned shapes, IDs are UUIDs and hashes are lowercase SHA-256. Expected boundary failures use `Result<T>`; programmer defects throw.
- `src/store/`: the only place SQL lives (`schema.sql`, `database.ts` RunStore). It handles ownership generations/fencing, the action journal (unknown outcomes are preserved, never auto-replayed), and artifacts.
- `src/runtime/`: supervisor client, WSL launch support, and independent verifier command boundary.
- `native/supervisor/`: Rust process owner. On Windows it uses Job Objects (`windows.rs`); on Linux/WSL it uses systemd units/cgroups via zbus (`linux.rs`).
- `src/providers/`: provider adapters. `codex/` is native Windows Codex app-server over stdio. `claude/` and `adapters/claude/` contain a WSL Claude bridge/SDK integration, but it is not wired to the `run` command.
- `src/workspace/`: local task snapshot, source-preservation checks, candidate scope enforcement and patch export.
- `src/controller/run-task.ts`: explicit user-task orchestration. It invokes the implementation and verifier, persists a report, and does not read or confer qualification.
- `src/controller/codex-task-runtime.ts`: observed Windows Codex runtime compatibility/identity checks and independent verification dispatch.
- `src/qualification/`: separate provider capability ledger and qualification probes. This evidence is incomplete; no `run` result closes qualification blockers.
- `src/cli/`: `main.ts` dispatches `run`, passive `doctor`, and qualification-specific commands.

Trusted task state lives outside worker-writable paths: `%LOCALAPPDATA%\Ouroboros\tasks`; run workspaces are siblings under `%LOCALAPPDATA%\Ouroboros\workspaces`. The original source checkout remains separate.

## Retained qualification status

The 17 October 2026 native Windows functional run `07120738-56ea-4a6b-ab88-7ffe6a6d7368` reached `READY_FOR_REVIEW` with the original source preserved and owned processes drained. That historical success does not accept the installed runtime or complete Task 7: five startup decisions remain open and 0 of 32 probes are accepted. Stop on a failed required capability; a further live qualification retry requires fresh authorization. npm manifests use compatible ranges with `save-exact=false`; lockfiles preserve resolved snapshots.
