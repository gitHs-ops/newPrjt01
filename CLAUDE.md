# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

빌드 단계가 없는 **정적 HTML 앱 두 벌**(로그인 데모 · 진로상담 분석)이며,
장시간 에이전트 작업을 전제로 한 **하네스**(`init.ps1` + `feature_list.json` +
`claude-progress.md`)가 얹혀 있다. 속도보다 **재개 가능성과 실증**이 우선이다.

## Commands

```powershell
.\init.ps1                       # 검증만 (저장소 안의 텍스트만 본다, ~68개 항목)
.\init.ps1 -Live                 # + 배포된 프록시 /exec 실호출로 버전 대조 (외부 연결 세션이면 필수)
.\init.ps1 -Start                # 검증 후 http://localhost:8940/ 기동
.\init.ps1 -Start -OpenBrowser   # 기동 + 브라우저
.\init.ps1 -Port 9000 -Start     # 포트 변경
```

```bash
python tools/build-prompts.py            # assets/prompts/*.txt -> assets/career-prompts.js 재생성
python tools/check-report.py <파일.md>   # 저장된 보고서가 끝까지 나왔는지 검사 (exit 0/1)
python tools/check-report.py --kind 2 <파일.md>   # 1차/2차 자동판별을 덮어씀
start http://localhost:8940/tools/obsidian-check.html   # 옵시디언 연결 5단계 실측
```

`init.ps1` 이 이 저장소의 테스트 러너다. 개별 테스트를 고르는 방식이 아니라
전 항목 일괄 실행이며, `[FAIL]` 이 하나라도 있으면 exit 1 이다.
`.claude/launch.json` 의 `newPrjt01-static` 은 같은 서버(`python -m http.server 8940`)를 띄운다.

### 용어 (기록할 때 이 말을 쓴다)

저장소 문서·커밋·`claude-progress.md` 가 이미 이 용어로 씌어 있다. 새 이름을 만들지 말 것.

| 대상 | 이름 |
|---|---|
| `.\init.ps1` | **표준 시작 경로**(Standard startup path) — 검증만 |
| `-Start` / `-Start -OpenBrowser` | 그 경로의 **기동 모드** |
| `python -m http.server 8940` | **Standard start command** |
| 브라우저로 전 경로를 직접 밟아 확인하는 행위 | **실기동 검증** (기록 문구: "실기동 전 경로 통과") |

`init.ps1` 은 저장소 텍스트와 배포본 버전만 본다. **화면 동작·시트 기록·옵시디언 쓰기는
실기동 검증으로만 확인된다** — 하네스를 아무리 다시 돌려도 그쪽은 검증되지 않는다.

## Architecture

### 정적 앱 (빌드 없음, 서버 없음)

페이지는 전역 객체 두 개에 의존한다. 새 페이지도 같은 방식으로 붙인다.

- `assets/auth.js` → `window.Auth` — PBKDF2-SHA256(10만회)+솔트 해싱, `np_users`/`np_session`,
  `requireAuth()` 가드. **Web Crypto 를 쓰므로 `file://` 로 열면 동작하지 않는다.**
- `assets/career.js` → `window.Career` (~1,400줄) — 사례 저장소(`np_career_cases`),
  설정(`np_career_config`), 프롬프트 조립, `callAI`, 마크다운 렌더, md 저장,
  옵시디언 `PUT`, 공통 UI(`mountChrome`). 상태는 전부 `localStorage`.
- `assets/career-prompts.js` → `window.CareerPrompts` — **자동 생성물. 직접 고치지 말 것.**
  원본은 `assets/prompts/*.txt` 이고 `tools/build-prompts.py` 로 재생성한다.
  (`init.ps1` 이 원문 mtime 이 생성물보다 최신이면 검증을 실패시킨다.)

흐름: `index → login → home` → (진로상담) `career → career-step1 → career-report1 →
career-step2 → career-report2`.

### AI 프록시 (이 저장소 밖에서 돌아간다)

브라우저는 API 키를 갖지 않는다. Apps Script 웹앱 하나가 **두 앱을 함께** 받는다.

| 경로 | 앱 | 비고 |
|---|---|---|
| `GET ?prompt=...` | 형제 프로젝트 `careerTest` | 고정 system, HTML 출력 — **건드리면 그쪽이 죽는다** |
| `POST {system, prompt, ...}` | 이 앱 | `text/plain` 으로 보낸다 (GAS CORS preflight 회피) |

- 저장소에는 `tools/career_proxy.example.gs`(키 없음)만 둔다. 실 파일 `career_proxy.gs` 와
  `local.endpoint.txt`(배포 `/exec` URL)는 `.gitignore` 로 막혀 있다 — **지우지 말 것.**
- **버전 대조가 3중이다.** `.gs` 의 `PROXY_VERSION` ↔ `career.js` 의
  `EXPECTED_PROXY_VERSION`(현재 `1.7.2`) ↔ 배포본이 응답하는 `version`.
  `.gs` 를 고치면 셋을 같이 올리고 **배포 관리 → 편집 → 새 버전**으로 재배포한다.
  ("새 배포"를 만들면 `/exec` URL 이 바뀌어 careerTest 가 끊긴다.)
  저장소만 고치고 재배포를 잊는 사고가 실제로 있었고, `-Live` 가 그걸 잡는다.
- 프록시가 사용자별 토큰 사용량을 careerTest 구글 시트의 전용 탭
  `진로상담 토큰로그` 에 기록한다. 공용 탭 `토큰로그` 미러링은 **v1.8.0 에서 껐다**
  (이중 기록). 코드는 `MIRROR_TO_SHARED=false` 로 남아 있고 `init.ps1` 이 이 값을 검사한다.
  되돌린다면 공용 탭의 **8열 형식은 절대 바꾸지 말 것** — careerTest 집계가 깨진다.

### 자주 밟는 지뢰

- `init.ps1` 은 **UTF-8 BOM** 이어야 한다. 없으면 PS 5.1 이 cp949 로 읽어 파서가 죽는다.
  (init.ps1 이 자기 BOM 을 검사한다.) 나머지 텍스트 파일은 U+FFFD 가 섞이면 실패한다.
- **Windows PowerShell 5.1** 호환만 쓴다 — `&&`, 삼항연산자, `??` 금지.
- 모델별 요청 형태가 다르다. Haiku 4.5 는 `web_search_20250305` 만 받고
  `output_config.effort` 를 보내면 400 이다. 프록시의 `supportsNewWebTools_` /
  `supportsEffort_` 분기를 없애지 말 것.
- Apps Script 는 **실행 6분에서 강제 종료**된다. `DEFAULT_EFFORT=low`,
  `MAX_CONTINUATIONS<=2`, `DEADLINE_MS=4분` 이 그 방어선이다.
- 보고서 끝단(STEP 11 최종 브리프·면책 문장) 잘림이 네 번 재발했다.
  보고서 산출 경로를 건드렸으면 **눈으로 보지 말고** `tools/check-report.py` 로 확인한다.
- `sk-ant-` 문자열이 저장소 어디든 들어가면 검증이 실패한다.
- **배포된 `/exec` URL 도 소스에 박으면 실패한다.** 설정은 오리진별 `localStorage` 라
  다른 주소(GitHub Pages 등)에서는 [연결 설정]을 다시 넣어야 하는데, 그걸 피하려고
  `DEFAULT_CONFIG.endpoint` 에 박으면 공개 소스로 URL 이 새어 누구나 이 계정의
  API 키로 호출한다. URL 은 `local.endpoint.txt` 에만 둔다(자리표시자 `.../exec` 는 무해).
- 학생 개인정보가 담긴 `*.report.md` / `reports/` 는 커밋 금지(`.gitignore`).

## Operating Loop

세션 시작 시:

1. `pwd` 로 저장소 루트 확인.
2. `claude-progress.md` 읽기 (최근 세션 로그 + 검증된 상태).
3. `feature_list.json` 읽기 (기능 상태의 단일 원본).
4. `git log --oneline -5`.
5. `.\init.ps1` 실행. 외부 연결(프록시·시트·옵시디언)을 건드릴 세션이면 `.\init.ps1 -Live`.
6. 베이스라인이 이미 깨져 있으면 **그것부터** 고친다. 깨진 위에 새 기능을 쌓지 않는다.

그다음 미완 기능을 **정확히 하나** 골라, 검증하거나 막힌 이유를 기록할 때까지 그것만 한다.

## Rules

- 한 번에 한 기능.
- 실행 가능한 근거 없이 완료를 주장하지 않는다.
- 미완을 감추려고 feature list 를 고쳐 쓰지 않는다.
- 통과시키려고 검사를 지우거나 약화하지 않는다.
- 채팅 요약이 아니라 저장소 아티팩트가 기록의 원본이다.

## Completion Gate

`passing` 으로 올리려면 요구된 검증이 실제로 통과하고 그 결과가 기록돼야 한다.
`feature_list.json` 의 `evidence` 가 비어 있는데 `passing` 이면
**`init.ps1` 이 검증을 실패시킨다** — 형식적 규칙이 아니다.

## Before You Stop

1. `claude-progress.md` 갱신 (세션 로그 + Next best step).
2. `feature_list.json` 상태·근거 갱신.
3. 아직 깨졌거나 미검증인 것을 `session-handoff.md` 에 남긴다.
4. 안전한 상태에서 커밋.
5. 다음 세션이 `.\init.ps1` 을 바로 돌릴 수 있는 상태로 둔다.
