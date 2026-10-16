# Публикация читалки на GitHub Pages из командной строки.
#
# Пример:
#   .\push-to-github.ps1 -Token github_pat_xxx -Repo fb2-reader
#
# Скрипт создаёт (если нужно) репозиторий, заливает файлы приложения одним
# коммитом и включает GitHub Pages. Книги и прогресс сюда не попадают —
# они живут в отдельном приватном репозитории, который вы укажете в приложении.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Repo = 'fb2-reader',
  [string]$Owner,
  [string]$Branch = 'main',
  [string]$SourceDir,
  [string]$CommitMessage = 'Публикация читалки FB2',
  [switch]$SkipPages
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Api {
  param([string]$Method, [string]$Path, $Body, [switch]$AllowFailure)
  $uri = if ($Path -like 'http*') { $Path } else { "https://api.github.com$Path" }
  $req = @{
    Method      = $Method
    Uri         = $uri
    Headers     = @{
      Authorization          = "Bearer $Token"
      Accept                 = 'application/vnd.github+json'
      'X-GitHub-Api-Version' = '2022-11-28'
      'User-Agent'           = 'fb2-reader-publisher'
    }
    ErrorAction = 'Stop'
  }
  if ($null -ne $Body) {
    $req.ContentType = 'application/json; charset=utf-8'
    $req.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 20 -Compress))
  }
  try {
    return Invoke-RestMethod @req
  } catch {
    if ($AllowFailure) { return $null }
    $status = $null
    try { $status = $_.Exception.Response.StatusCode.value__ } catch { }
    $detail = ''
    try {
      $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
      $detail = $reader.ReadToEnd()
    } catch { }
    throw "GitHub API $Method $Path -> $status $detail"
  }
}

# --- 1. Кто мы ---
$me = Api GET '/user'
if (-not $Owner) { $Owner = $me.login }
Write-Host "Аккаунт: $($me.login)  Репозиторий: $Owner/$Repo" -ForegroundColor Cyan

# --- 2. Репозиторий ---
$repoInfo = Api GET "/repos/$Owner/$Repo" -AllowFailure
if (-not $repoInfo) {
  Write-Host "Создаю репозиторий $Repo..." -ForegroundColor Yellow
  $repoInfo = Api POST '/user/repos' @{
    name        = $Repo
    description = 'Читалка FB2 с синхронизацией позиции чтения'
    private     = $false
    auto_init   = $true
  }
  Start-Sleep -Seconds 2
}
$Branch = if ($repoInfo.default_branch) { $repoInfo.default_branch } else { $Branch }
if ($repoInfo.private) {
  Write-Host 'Внимание: репозиторий приватный. GitHub Pages для приватных репозиториев требует платный тариф.' -ForegroundColor Yellow
}

# --- 3. Собираем файлы ---
if (-not $SourceDir) { $SourceDir = Split-Path -Parent $PSScriptRoot }
$SourceDir = (Resolve-Path $SourceDir).Path
$exclude = @('node_modules', '.git', '.github', '__pycache__')
$files = Get-ChildItem -Path $SourceDir -Recurse -File | Where-Object {
  $rel = $_.FullName.Substring($SourceDir.Length).TrimStart('\', '/')
  $parts = $rel -split '[\\/]'
  -not ($parts | Where-Object { $exclude -contains $_ }) -and $_.Length -lt 90MB
}
Write-Host "Файлов к загрузке: $($files.Count)" -ForegroundColor Cyan

# --- 4. Блобы ---
$tree = @()
foreach ($f in $files) {
  $rel = $f.FullName.Substring($SourceDir.Length).TrimStart('\', '/') -replace '\\', '/'
  $bytes = [IO.File]::ReadAllBytes($f.FullName)
  $b64 = [Convert]::ToBase64String($bytes)
  $blob = Api POST "/repos/$Owner/$Repo/git/blobs" @{ content = $b64; encoding = 'base64' }
  $tree += @{ path = $rel; mode = '100644'; type = 'blob'; sha = $blob.sha }
  Write-Host "  + $rel ($([math]::Round($f.Length/1KB,1)) КБ)"
}

# --- 5. Коммит ---
$ref = Api GET "/repos/$Owner/$Repo/git/ref/heads/$Branch" -AllowFailure
if ($ref) {
  $headSha = $ref.object.sha
  $head = Api GET "/repos/$Owner/$Repo/git/commits/$headSha"
  $baseTree = $head.tree.sha
  $parents = @($headSha)
} else {
  $baseTree = $null
  $parents = @()
}

$treeBody = @{ tree = $tree }
if ($baseTree) { $treeBody.base_tree = $baseTree }
$newTree = Api POST "/repos/$Owner/$Repo/git/trees" $treeBody

$newCommit = Api POST "/repos/$Owner/$Repo/git/commits" @{
  message = $CommitMessage
  tree    = $newTree.sha
  parents = $parents
}

if ($ref) {
  Api PATCH "/repos/$Owner/$Repo/git/refs/heads/$Branch" @{ sha = $newCommit.sha; force = $false } | Out-Null
} else {
  Api POST "/repos/$Owner/$Repo/git/refs" @{ ref = "refs/heads/$Branch"; sha = $newCommit.sha } | Out-Null
}
Write-Host 'Файлы загружены.' -ForegroundColor Green

# --- 6. GitHub Pages ---
if (-not $SkipPages) {
  $pages = Api GET "/repos/$Owner/$Repo/pages" -AllowFailure
  if ($pages) {
    Api PUT "/repos/$Owner/$Repo/pages" @{ source = @{ branch = $Branch; path = '/' } } -AllowFailure | Out-Null
    Write-Host 'GitHub Pages уже был включён.'
  } else {
    $created = Api POST "/repos/$Owner/$Repo/pages" @{ source = @{ branch = $Branch; path = '/' } } -AllowFailure
    if ($created) { Write-Host 'GitHub Pages включён.' -ForegroundColor Green }
    else { Write-Host 'Не удалось включить Pages автоматически — включите вручную: Settings → Pages → Source: Deploy from a branch, main / (root).' -ForegroundColor Yellow }
  }
}

$url = "https://$Owner.github.io/$Repo/"
Write-Host ''
Write-Host "Готово. Адрес читалки (появится через 1-2 минуты):" -ForegroundColor Cyan
Write-Host "  $url" -ForegroundColor White
Write-Host ''
Write-Host 'Дальше: откройте адрес, укажите приватный репозиторий для книг и токен,'
Write-Host 'и получите ссылку с зашитым токеном для остальных устройств.'
