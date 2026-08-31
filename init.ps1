<#
    newPrjt01 — 세션 초기화 스크립트 (Windows PowerShell)

    init.sh 를 대체한다. 이 저장소는 빌드 단계가 없는 정적 HTML 앱이라
    설치할 의존성이 없고, 검증은 "파일이 제자리에 있고 형태가 온전한가"로 대체한다.

    사용법:
      .\init.ps1                    검증만 수행
      .\init.ps1 -Start             검증 후 로컬 서버 기동
      .\init.ps1 -Start -OpenBrowser  기동 후 브라우저까지 염

    Windows PowerShell 5.1 호환 (&&, 삼항연산자, ?? 미사용).
#>

[CmdletBinding()]
param(
    [switch]$Start,
    [switch]$OpenBrowser,
    [int]$Port = 8940
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$script:Failures = 0

function Write-Head($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    [OK]   $text" -ForegroundColor Green }
function Write-Fail($text) { Write-Host "    [FAIL] $text" -ForegroundColor Red; $script:Failures++ }
function Write-Note($text) { Write-Host "    $text" -ForegroundColor DarkGray }

Write-Head "Working directory: $PSScriptRoot"

# ---------------------------------------------------------------- 의존성
Write-Head "Syncing dependencies"
Write-Note "(정적 HTML 앱 — 설치할 의존성 없음, 건너뜀)"

# ---------------------------------------------------------------- 검증
Write-Head "Running baseline verification"

# 1) 하네스 파일
$harnessFiles = @('AGENTS.md', 'CLAUDE.md', 'feature_list.json', 'claude-progress.md', 'session-handoff.md')
foreach ($f in $harnessFiles) {
    if (Test-Path -LiteralPath $f -PathType Leaf) { Write-Ok $f } else { Write-Fail "$f 없음" }
}

# 2) 앱 파일 — 로그인 데모 일습
$appFiles = @(
    'index.html',
    'login.html',
    'signup.html',
    'home.html',
    'error.html',
    'assets\auth.css',
    'assets\auth.js'
)
foreach ($f in $appFiles) {
    if (Test-Path -LiteralPath $f -PathType Leaf) { Write-Ok $f } else { Write-Fail "$f 없음" }
}

# 3) HTML 무결성 — 비어 있지 않고 <html> 을 포함하는가
foreach ($f in @('index.html', 'login.html', 'signup.html', 'home.html', 'error.html')) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
    $content = Get-Content -LiteralPath $f -Raw -Encoding UTF8
    if ($content.Length -gt 0 -and $content -match '(?i)<html') {
        Write-Ok "$f 형태 정상 (<html> 포함)"
    } else {
        Write-Fail "$f 가 비었거나 <html> 이 없음"
    }
}

# 4) 각 페이지가 공통 자산을 참조하는가 (경로 오타 조기 탐지)
foreach ($f in @('login.html', 'signup.html', 'home.html', 'error.html')) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
    $content = Get-Content -LiteralPath $f -Raw -Encoding UTF8
    $hasCss = $content -match 'assets/auth\.css'
    $hasJs  = $content -match 'assets/auth\.js'
    if ($hasCss -and $hasJs) {
        Write-Ok "$f 가 auth.css / auth.js 를 참조"
    } else {
        Write-Fail "$f 의 공통 자산 참조 누락 (css=$hasCss js=$hasJs)"
    }
}

# 5) auth.js 의 공개 API 가 살아 있는가
if (Test-Path -LiteralPath 'assets\auth.js' -PathType Leaf) {
    $js = Get-Content -LiteralPath 'assets\auth.js' -Raw -Encoding UTF8
    $needed = @('signup', 'login', 'googleLoginDemo', 'resetPassword',
                'getSession', 'clearSession', 'requireAuth', 'isIdTaken')
    $missing = @()
    foreach ($fn in $needed) {
        if ($js -notmatch [regex]::Escape($fn)) { $missing += $fn }
    }
    if ($missing.Count -eq 0) {
        Write-Ok "auth.js 공개 API $($needed.Count)종 확인"
    } else {
        Write-Fail "auth.js 에서 누락된 API: $($missing -join ', ')"
    }

    # 비밀번호를 평문으로 다루지 않는지 최소 확인
    if ($js -match 'PBKDF2') {
        Write-Ok "비밀번호 해싱(PBKDF2) 경로 존재"
    } else {
        Write-Fail "auth.js 에 PBKDF2 해싱이 보이지 않음 — 평문 저장 여부 확인 필요"
    }
}

# 6) feature_list.json 이 올바른 JSON 인가
if (Test-Path -LiteralPath 'feature_list.json' -PathType Leaf) {
    try {
        $raw = Get-Content -LiteralPath 'feature_list.json' -Raw -Encoding UTF8
        $features = ($raw | ConvertFrom-Json).features
        Write-Ok "feature_list.json 파싱 성공 (기능 $($features.Count)개)"

        $blocked = @($features | Where-Object { $_.status -eq 'blocked' })
        if ($blocked.Count -gt 0) {
            Write-Note "주의: blocked 상태 기능 $($blocked.Count)건 — $($blocked.id -join ', ')"
        }
    } catch {
        Write-Fail "feature_list.json 이 올바른 JSON 이 아님: $($_.Exception.Message)"
    }
}

# 7) 실행에 필요한 python
$python = Get-Command python -ErrorAction SilentlyContinue
if ($python) {
    $ver = (& python --version 2>&1 | Out-String).Trim()
    Write-Ok "python 사용 가능 ($ver)"
} else {
    Write-Fail "python 을 찾을 수 없음 — 서버를 기동할 수 없다"
}

# 8) 포트 점유 여부 (실패가 아니라 정보)
$inUse = $null
try {
    $inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
} catch {
    $inUse = $null
}
if ($inUse) {
    Write-Note "참고: 포트 $Port 를 이미 누군가 듣고 있음 (기동 시 충돌 가능)"
} else {
    Write-Ok "포트 $Port 사용 가능"
}

# ---------------------------------------------------------------- 결과
if ($script:Failures -gt 0) {
    Write-Host ""
    Write-Head "검증 실패 — [FAIL] $($script:Failures)건. 위 항목을 먼저 해결할 것."
    exit 1
}

Write-Head "검증 통과"

# ---------------------------------------------------------------- 기동
Write-Head "Startup command"
Write-Host "    python -m http.server $Port" -ForegroundColor Yellow
Write-Host "    http://localhost:$Port/           첫 화면" -ForegroundColor DarkGray
Write-Host "    http://localhost:$Port/login.html 로그인" -ForegroundColor DarkGray
Write-Host "    http://localhost:$Port/signup.html 회원가입" -ForegroundColor DarkGray

if (-not $Start) {
    Write-Host ""
    Write-Host "앱까지 바로 띄우려면 .\init.ps1 -Start 를 실행하세요." -ForegroundColor DarkGray
    exit 0
}

if ($OpenBrowser) {
    Start-Process "http://localhost:$Port/login.html"
}

Write-Head "Starting the app  (Ctrl+C 로 중지)"
& python -m http.server $Port
exit $LASTEXITCODE
