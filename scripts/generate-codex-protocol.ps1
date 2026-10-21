param(
  [Parameter(Mandatory=$true)][string]$CodexExecutable,
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [string]$PreparedRoot,
  [switch]$ResumeFailedImport
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathFullyQualified($CodexExecutable) -or -not (Test-Path -LiteralPath $CodexExecutable -PathType Leaf)) { throw 'Absolute existing Codex executable required' }
$pin = (Get-FileHash -LiteralPath $CodexExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
$versionOutput = & $CodexExecutable --version
if ($LASTEXITCODE -ne 0 -or ($versionOutput -join "`n") -notmatch '^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)$') { throw 'Unrecognized Codex version response' }
$runtimeVersion = $Matches[1]
if (-not [IO.Path]::IsPathFullyQualified($OutputRoot)) { throw 'Absolute output root required' }
$OutputRoot = Join-Path $OutputRoot ($runtimeVersion + '-' + $pin)
if ((Test-Path -LiteralPath $OutputRoot) -and -not ($PreparedRoot -and $ResumeFailedImport)) { throw 'Fresh runtime-specific output root required (or explicitly resume verified prepared import)' }
if ($PreparedRoot) {
  $rawTs = Join-Path $PreparedRoot ('typescript-' + $runtimeVersion)
  $rawJson = Join-Path $PreparedRoot ('json-schema-' + $runtimeVersion)
  $preparedManifestPath = Join-Path ([IO.Path]::GetDirectoryName($PreparedRoot.TrimEnd('\','/'))) 'task-5-generated-manifest.json'
  $preparedManifest = Get-Content -LiteralPath $preparedManifestPath -Raw | ConvertFrom-Json
  if ($preparedManifest.runtimeVersion -ne $runtimeVersion -or $preparedManifest.binarySha256 -ne $pin) { throw 'Prepared manifest runtime identity mismatch' }
  if (@($preparedManifest.roots).Count -ne 2) { throw 'Prepared manifest must contain exactly two roots' }
  foreach ($root in $preparedManifest.roots) {
    $preparedSource = if ($root.root.EndsWith(('typescript-' + $runtimeVersion))) { $rawTs } elseif ($root.root.EndsWith(('json-schema-' + $runtimeVersion))) { $rawJson } else { throw 'Unexpected prepared root' }
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
  $rawTs = Join-Path $stage ('typescript-' + $runtimeVersion)
  $rawJson = Join-Path $stage ('json-schema-' + $runtimeVersion)
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
if ((Get-FileHash -LiteralPath $CodexExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin) { throw 'Codex executable changed during generation' }
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
$manifest = @{schemaVersion=1;runtimeVersion=$runtimeVersion;binarySha256=$pin;transform='relative-type-specifier-js-v1; verify target .ts; exact root namespace export ./v2 becomes ./v2/index.js after target check; no other changes';rawTypeScriptRoot=$rawTs;rawJsonRoot=$rawJson;files=$rows.ToArray()}
[IO.File]::WriteAllText((Join-Path $OutputRoot 'provenance.json'), ($manifest | ConvertTo-Json -Depth 6),$encoding)
