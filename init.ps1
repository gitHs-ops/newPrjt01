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

# 2b) 앱 파일 — 진로상담 일습
$careerFiles = @(
    'career.html',
    'career-step1.html',
    'career-report1.html',
    'career-step2.html',
    'career-report2.html',
    'assets\career.css',
    'assets\career.js',
    'assets\career-prompts.js',
    'assets\prompts\prompt-1st.txt',
    'assets\prompts\prompt-2nd.txt',
    'assets\prompts\input-1st.txt',
    'assets\prompts\input-2nd.txt',
    'tools\build-prompts.py',
    'tools\career_proxy.example.gs'
)
foreach ($f in $careerFiles) {
    if (Test-Path -LiteralPath $f -PathType Leaf) { Write-Ok $f } else { Write-Fail "$f 없음" }
}

# 3) HTML 무결성 — 비어 있지 않고 <html> 을 포함하는가
foreach ($f in @('index.html', 'login.html', 'signup.html', 'home.html', 'error.html',
                 'career.html', 'career-step1.html', 'career-report1.html',
                 'career-step2.html', 'career-report2.html')) {
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

# 5b) 진로상담 페이지가 공통 자산을 참조하는가
foreach ($f in @('career.html', 'career-step1.html', 'career-report1.html',
                 'career-step2.html', 'career-report2.html')) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
    $content = Get-Content -LiteralPath $f -Raw -Encoding UTF8
    $hasCss     = $content -match 'assets/career\.css'
    $hasJs      = $content -match 'assets/career\.js'
    $hasPrompts = $content -match 'assets/career-prompts\.js'
    $hasAuth    = $content -match 'assets/auth\.js'
    if ($hasCss -and $hasJs -and $hasPrompts -and $hasAuth) {
        Write-Ok "$f 가 career.css / career.js / career-prompts.js / auth.js 를 참조"
    } else {
        Write-Fail "$f 의 공통 자산 참조 누락 (css=$hasCss js=$hasJs prompts=$hasPrompts auth=$hasAuth)"
    }
}

# 5c) career.js 의 공개 API 가 살아 있는가
if (Test-Path -LiteralPath 'assets\career.js' -PathType Leaf) {
    $cjs = Get-Content -LiteralPath 'assets\career.js' -Raw -Encoding UTF8
    $needed = @('createCase', 'listCases', 'updateCase', 'deleteCase',
                'buildUserMessage1', 'buildUserMessage2', 'callAI',
                'mdToHtml', 'downloadMd', 'sendToObsidian', 'mountChrome')
    $missing = @()
    foreach ($fn in $needed) {
        if ($cjs -notmatch [regex]::Escape($fn)) { $missing += $fn }
    }
    if ($missing.Count -eq 0) {
        Write-Ok "career.js 공개 API $($needed.Count)종 확인"
    } else {
        Write-Fail "career.js 에서 누락된 API: $($missing -join ', ')"
    }

    # AI 호출이 실제 네트워크 경로를 갖는가 (프롬프트 복사 방식으로 되돌아가지 않았는지)
    if ($cjs -match 'fetch\(endpoint') {
        Write-Ok "AI 호출 경로(fetch) 존재"
    } else {
        Write-Fail "career.js 에 AI 호출용 fetch 가 보이지 않음"
    }

    # 옵시디언 전송은 아직 '표시만' — 스텁이 살아 있는지 확인
    if ($cjs -match 'OBSIDIAN_PENDING_MSG') {
        Write-Ok "옵시디언 전송 스텁 존재 (추후 결정 상태)"
    } else {
        Write-Fail "옵시디언 전송 스텁이 사라짐 — 연결 여부를 확인할 것"
    }

    # 공식자료 웹검색 지시가 요청에 실려 나가는가 (프롬프트가 요구하는 전제)
    if ($cjs -match 'web_search:' -and $cjs -match 'search_max_uses') {
        Write-Ok "요청에 웹검색 지시(web_search / search_max_uses) 포함"
    } else {
        Write-Fail "career.js 가 웹검색 지시를 보내지 않음 — 확인 불가 응답이 대량 발생한다"
    }

    if ($cjs -match 'OFFICIAL_DOMAINS' -and $cjs -match 'renderSources') {
        Write-Ok "공식 도메인 목록 · 출처 표시 경로 존재"
    } else {
        Write-Fail "career.js 에 OFFICIAL_DOMAINS / renderSources 가 없음"
    }
}

# 5c-2) 프록시 참고 구현이 웹검색을 켜는가
if (Test-Path -LiteralPath 'tools\career_proxy.example.gs' -PathType Leaf) {
    $gs = Get-Content -LiteralPath 'tools\career_proxy.example.gs' -Raw -Encoding UTF8
    $needed = @('web_search_20260209', 'pause_turn', 'web_search_tool_result', 'doPost')
    $missing = @()
    foreach ($k in $needed) {
        if ($gs -notmatch [regex]::Escape($k)) { $missing += $k }
    }
    if ($missing.Count -eq 0) {
        Write-Ok "프록시 예시가 웹검색·이어달리기·출처수집을 구현 ($($needed.Count)종)"
    } else {
        Write-Fail "career_proxy.example.gs 에서 누락: $($missing -join ', ')"
    }
}

# 5c-3) API 키가 저장소에 섞여 들어가지 않았는가 (careerTest 프록시 복사 사고 방지)
$keyHits = @()
foreach ($f in (Get-ChildItem -Recurse -File -Include *.gs, *.js, *.html, *.md, *.json, *.ps1, *.py |
                Where-Object { $_.FullName -notmatch '\\\.git\\' })) {
    $t = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8
    if ($t -match 'sk-ant-[A-Za-z0-9]') { $keyHits += $f.Name }
}
if ($keyHits.Count -eq 0) {
    Write-Ok "저장소에 Anthropic API 키 문자열 없음"
} else {
    Write-Fail "API 키로 보이는 문자열 발견: $($keyHits -join ', ') — 즉시 제거하고 키를 폐기할 것"
}

# 5d) 프롬프트 생성물이 원문과 동기화되어 있는가
if ((Test-Path -LiteralPath 'assets\career-prompts.js' -PathType Leaf) -and
    (Test-Path -LiteralPath 'tools\build-prompts.py' -PathType Leaf)) {
    $gen = Get-Item -LiteralPath 'assets\career-prompts.js'
    $stale = @()
    foreach ($p in @('prompt-1st.txt', 'prompt-2nd.txt', 'input-1st.txt', 'input-2nd.txt')) {
        $src = Join-Path 'assets\prompts' $p
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { continue }
        if ((Get-Item -LiteralPath $src).LastWriteTime -gt $gen.LastWriteTime) { $stale += $p }
    }
    if ($stale.Count -eq 0) {
        Write-Ok "career-prompts.js 가 프롬프트 원문보다 최신"
    } else {
        Write-Fail "프롬프트 원문이 더 최신임 ($($stale -join ', ')) — python tools/build-prompts.py 실행 필요"
    }

    $gjs = Get-Content -LiteralPath 'assets\career-prompts.js' -Raw -Encoding UTF8
    if ($gjs -match 'CareerPrompts' -and $gjs.Length -gt 20000) {
        Write-Ok "career-prompts.js 에 프롬프트 원문이 담겨 있음 ($([int]($gjs.Length/1024))KB)"
    } else {
        Write-Fail "career-prompts.js 가 비었거나 CareerPrompts 전역이 없음"
    }
}

# 5e) 로그인 성공 페이지가 진로상담으로 연결되는가
if (Test-Path -LiteralPath 'home.html' -PathType Leaf) {
    $homeHtml = Get-Content -LiteralPath 'home.html' -Raw -Encoding UTF8
    if ($homeHtml -match 'career\.html') {
        Write-Ok "home.html 에서 진로상담(career.html) 진입 링크 확인"
    } else {
        Write-Fail "home.html 에 career.html 링크가 없음"
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
Write-Host "    http://localhost:$Port/career.html 진로상담 (로그인 필요)" -ForegroundColor DarkGray

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
