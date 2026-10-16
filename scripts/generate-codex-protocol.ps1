param(
  [Parameter(Mandatory=$true)][string]$CodexExecutable,
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [string]$PreparedRoot,
  [switch]$ResumeFailedImport
)
$ErrorActionPreference = 'Stop'
$pin = 'dd13bdb162a184fa04039488b234a8258ef9b76f84e926c505d5742b19249a6a'
if (-not [IO.Path]::IsPathFullyQualified($CodexExecutable) -or (Get-FileHash -LiteralPath $CodexExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin) { throw 'Pinned absolute Codex 0.162.1 executable required' }
if (-not [IO.Path]::IsPathFullyQualified($OutputRoot) -or ((Test-Path -LiteralPath $OutputRoot) -and -not ($PreparedRoot -and $ResumeFailedImport))) { throw 'Fresh absolute output root required (or explicitly resume verified prepared import)' }
if ($PreparedRoot) {
  $rawTs = Join-Path $PreparedRoot 'typescript-0.162.1'
  $rawJson = Join-Path $PreparedRoot 'json-schema-0.162.1'
  $preparedManifestPath = Join-Path ([IO.Path]::GetDirectoryName($PreparedRoot.TrimEnd('\','/'))) 'task-5-generated-manifest.json'
  $preparedManifest = Get-Content -LiteralPath $preparedManifestPath -Raw | ConvertFrom-Json
  foreach ($root in $preparedManifest.roots) {
    $preparedSource = if ($root.root.EndsWith('typescript-0.162.1')) { $rawTs } else { $rawJson }
    if ([IO.Directory]::GetFiles($preparedSource,'*',[IO.SearchOption]::AllDirectories).Length -ne $root.fileCount) { throw 'Prepared file count mismatch' }
    foreach ($entry in $root.files) {
      $preparedFile = Join-Path $preparedSource $entry.path
      if ([IO.FileInfo]::new($preparedFile).Length -ne $entry.bytes -or (Get-FileHash -LiteralPath $preparedFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw 'Prepared raw provenance mismatch' }
    }
  }
} else {
  # Fresh staging remains as raw provenance. No existing configuration is changed.
  $stage = Join-Path ([IO.Path]::GetTempPath()) ('ouroboros-codegen-' + [Guid]::NewGuid())
  $isolatedHome = Join-Path $stage 'isolated-codex-home'
  New-Item -ItemType Directory -Path $isolatedHome | Out-Null
  $rawTs = Join-Path $stage 'typescript-0.162.1'
  $rawJson = Join-Path $stage 'json-schema-0.162.1'
  $previousHome = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'Process')
  try {
    [Environment]::SetEnvironmentVariable('CODEX_HOME', $isolatedHome, 'Process')
    # Generator-specific parsers do NOT support --strict-config or --stdio.
    & $CodexExecutable app-server generate-ts --out $rawTs
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript generation failed' }
    & $CodexExecutable app-server generate-json-schema --out $rawJson
    if ($LASTEXITCODE -ne 0) { throw 'JSON schema generation failed' }
  } finally { [Environment]::SetEnvironmentVariable('CODEX_HOME', $previousHome, 'Process') }
}
$encoding = [Text.UTF8Encoding]::new($false, $true)
$rows = [Collections.Generic.List[object]]::new()
foreach ($group in @(@{source=$rawTs;dest='typescript'},@{source=$rawJson;dest='json-schema'})) {
  $files = [IO.Directory]::GetFiles($group.source, '*', [IO.SearchOption]::AllDirectories)
  [Array]::Sort($files, [StringComparer]::Ordinal)
  foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($group.source,$file).Replace('\','/')
    $original = [IO.File]::ReadAllBytes($file)
    $bytes = $original
    if ($group.dest -eq 'typescript') {
      $content = $encoding.GetString($original)
      $content = [regex]::Replace($content, '(?m)^(import type .+? from |export type .+? from )"(\.{1,2}/[^"\r\n]+)";', {
        param($match)
        $specifier = $match.Groups[2].Value
        if ($specifier.EndsWith('.js') -or $specifier.EndsWith('.ts') -or -not (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($file)) ($specifier + '.ts')) -PathType Leaf)) { throw 'Unexpected generated import or missing target' }
        $match.Groups[1].Value + '"' + $specifier + '.js";'
      })
      if ($relative -eq 'index.ts' -and $content.Contains('export * as v2 from "./v2";')) {
        if (-not (Test-Path -LiteralPath (Join-Path $rawTs 'v2/index.ts') -PathType Leaf)) { throw 'Missing namespace index target' }
        $content = $content.Replace('export * as v2 from "./v2";', 'export * as v2 from "./v2/index.js";')
      }
      if ([regex]::IsMatch($content, '(?m)^\s*(?:import|export).*(?:from\s+["'']\.{1,2}/[^"'']+(?<!\.js)["''])')) { throw 'Unrecognized relative generated import/export' }
      $bytes = $encoding.GetBytes($content)
    }
    $destination = Join-Path (Join-Path $OutputRoot $group.dest) $relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    if (Test-Path -LiteralPath $destination) {
      if ([Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($destination))) -ne [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($bytes))) { throw 'Existing output differs; preserving it' }
    } else { [IO.File]::WriteAllBytes($destination,$bytes) }
    $rows.Add(@{path=($group.dest+'/'+$relative);rawBytes=$original.Length;rawSha256=[Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($original));bytes=$bytes.Length;sha256=[Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($bytes))})
  }
}
$manifest = @{schemaVersion=1;runtimeVersion='0.162.1';binarySha256=$pin;transform='relative-type-specifier-js-v1; verify target .ts; exact root namespace export ./v2 becomes ./v2/index.js after target check; no other changes';rawTypeScriptRoot=$rawTs;rawJsonRoot=$rawJson;files=$rows.ToArray()}
[IO.File]::WriteAllText((Join-Path $OutputRoot 'provenance.json'), ($manifest | ConvertTo-Json -Depth 6),$encoding)
