`approved-features-recipe.json` preserves the non-secret argv strings from the
historical Task 7 `diagnostic-correction-1/campaign/proposal.json`. Its source
SHA-256 is included in the fixture. No credentials or environment values were
copied. Tests have no dependency on ignored local repair evidence.

The roundtrip test parses each override's value as TOML and reproduces every
argv string byte for byte. A separate preflight assertion refuses the four
historical quoted MCP CLI path segments. OpenAI Codex commit
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`,
`codex-rs/config/src/overrides.rs`, uses literal dot splitting and preserves the
quote characters in those server names. The corrected candidate changes only
the four quoted MCP path tokens to bare simple segments. This source-proven
defect does not establish the cause of the historical 114-byte stderr failure.
