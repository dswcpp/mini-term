[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Destination,
  [string[]]$Skill = @(),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Resolve-SkillDestination {
  param([string]$Requested)

  if ($Requested) {
    return $Requested
  }

  if ($env:CODEX_HOME) {
    return (Join-Path $env:CODEX_HOME 'skills')
  }

  return (Join-Path $HOME '.codex\skills')
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$sourceRoot = Join-Path $repoRoot 'docs\skills'
$destinationRoot = Resolve-SkillDestination -Requested $Destination

if (-not (Test-Path -LiteralPath $sourceRoot)) {
  throw "Source skills directory not found: $sourceRoot"
}

$availableSkills = Get-ChildItem -LiteralPath $sourceRoot -Directory | Sort-Object Name
if ($availableSkills.Count -eq 0) {
  throw "No skills found under $sourceRoot"
}

$selectedSkills = if ($Skill.Count -gt 0) {
  $availableByName = @{}
  foreach ($item in $availableSkills) {
    $availableByName[$item.Name] = $item
  }

  foreach ($name in $Skill) {
    if (-not $availableByName.ContainsKey($name)) {
      $known = ($availableSkills.Name -join ', ')
      throw "Unknown skill '$name'. Available skills: $known"
    }
  }

  $Skill | ForEach-Object { $availableByName[$_] }
} else {
  $availableSkills
}

if (-not (Test-Path -LiteralPath $destinationRoot)) {
  if ($PSCmdlet.ShouldProcess($destinationRoot, 'Create destination directory')) {
    New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
  }
}

foreach ($skillDir in $selectedSkills) {
  $targetDir = Join-Path $destinationRoot $skillDir.Name
  $targetExists = Test-Path -LiteralPath $targetDir

  if ($targetExists -and -not $Force) {
    Write-Host "Skipping existing skill '$($skillDir.Name)' at $targetDir. Use -Force to replace it."
    continue
  }

  if ($targetExists -and $Force) {
    if ($PSCmdlet.ShouldProcess($targetDir, "Remove existing skill '$($skillDir.Name)'")) {
      Remove-Item -LiteralPath $targetDir -Recurse -Force
    }
  }

  if ($PSCmdlet.ShouldProcess($targetDir, "Install skill '$($skillDir.Name)'")) {
    Copy-Item -LiteralPath $skillDir.FullName -Destination $targetDir -Recurse -Force
    Write-Host "Installed '$($skillDir.Name)' -> $targetDir"
  }
}

Write-Host "Skill source: $sourceRoot"
Write-Host "Skill destination: $destinationRoot"
