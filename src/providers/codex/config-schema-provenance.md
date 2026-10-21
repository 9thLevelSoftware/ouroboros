The schema text embedded in `config-schema-0.162.1.ts` is the unmodified UTF-8
content of OpenAI Codex `codex-rs/core/config.schema.json` at commit
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` (Codex 0.162.1).

- Source: https://raw.githubusercontent.com/openai/codex/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/config.schema.json
- Repository: https://github.com/openai/codex
- License: Apache-2.0, https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/LICENSE
- Source size: 236751 bytes.
- Source SHA-256: `7933a70506e753a6e98c16800d2a76770b2af2b7295491f8f0b8e713e952027e`.
- Source Git blob SHA-1: `5864a5df77c600b6dfc9884d971040074fb6b644`.
- Generated representation: `export const pinnedConfigSchemaText: string = `
  followed by `JSON.stringify(sourceUtf8Text)` and a semicolon. The module
  verifies SHA-256 before compiling the schema. It reads no host file.

The verified source manifest and commit/tree checks are retained in the local
Task 7 repair evidence. Production imports only this checked-in module.
`PermissionsToml` and dynamic filesystem keys are permissive in the upstream
schema. The builder additionally validates each selected profile against the
schema's `PermissionProfileToml`, then applies closed filesystem/network and
required restriction checks. Schema format annotations are disabled in Ajv;
declared JSON Schema numeric ranges and types remain enforced. No coercion,
default insertion, unknown-property deletion, or remote schema loading occurs.

Runtime dependencies are exact pins, because production launch preflight calls
the parser and validator:

- `smol-toml@1.9.1`, https://github.com/squirrelchat/smol-toml,
  https://registry.npmjs.org/smol-toml/1.9.1
- `ajv@8.20.0`, https://github.com/ajv-validator/ajv,
  https://registry.npmjs.org/ajv/8.20.0

The lockfile records the exact tarball URLs, versions and SHA-512 integrity for
these packages and four new transitive packages. Installation used the pinned
Node 24.19.0 executable and npm `--save-exact --ignore-scripts --no-audit
--no-fund`. No added package defines preinstall/install/postinstall hooks.
Dependency docs used: https://github.com/squirrelchat/smol-toml#usage and
https://ajv.js.org/options.html. The encoder deliberately supports a bounded
TOML 1.0-compatible value subset and rejects null, bigint, dates, nonfinite or
unsafe numbers, sparse arrays and class instances instead of silently dropping
or converting them.

The lockfile identifies expected dependency artifacts; it is not proof of the
bytes currently installed in `node_modules`. Charged preparation must verify
the actual installed parser/validator/transitive bytes against the pinned
package artifacts and record that evidence before any new seal or live action.
Source identities bind this module, the schema module, `package.json` and the
lockfile so a reviewed implementation or expected dependency change invalidates
the prior identity. Installed-byte verification remains a separate gate.

Pinned CLI source authority:

- `codex-rs/cli/src/main.rs`: app-server accepts `--strict-config --stdio`;
  `--stdio` conflicts with `--listen`; features does not accept strict config.
- `codex-rs/cli/src/lib.rs`: sandbox supports `--permission-profile` and
  `--include-managed-config`; managed configuration requires a profile.
- `codex-rs/utils/cli/src/config_override.rs`: value TOML parsing has a raw
  string fallback. Our preflight refuses that fallback.
- `codex-rs/config/src/overrides.rs`: override paths use literal `split('.')`,
  without TOML key unquoting. The builder accepts only bare CLI path segments;
  quoted object keys inside TOML values remain supported.

All source paths above refer to the same pinned OpenAI commit. This structural
preflight neither reads effective runtime layers nor authorizes execution,
qualifies MXC restrictions, establishes MCP inventory completeness, or proves
startup inactivity. In particular, requesting `allow_local_binding=false`
does not establish its enforcement by MXC.

Strict-driver integration contract: `strict-negative` returns the actual argv
with the one injected `-c foo="bar"` pair. The existing `runStrictPair` driver
accepts equal baseline `request.argv` for positive and negative requests and
adds that pair itself to the negative launch. A future Task 7 recipe factory
must pass baseline request argv to that driver, bind the negative startup
intent's `argumentsHash` to the actual injected argv, and avoid appending the
injection twice. Each action/process keeps separate caller-owned identities;
the builder neither creates nor combines those identities.
