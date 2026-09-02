# Progress Log

<!--
이 파일명은 코스 예제와의 호환 때문에 유지된 것으로, Claude Code 전용이 아니다.
Codex·OpenHands 등 어떤 코딩 에이전트도 쓸 수 있다. 어떤 에이전트도 이 파일을
자동으로 갱신하지 않는다 — AGENTS.md / CLAUDE.md 의 지시에 따라 세션 시작 시 읽고
인계 전에 직접 갱신할 것.
-->

## Current Verified State

- **Repository root**: `C:\myPrjt01\newPrjt01`
- **Standard startup path**: `.\init.ps1` (Windows PowerShell)
  - `.\init.ps1` — 검증만 / `.\init.ps1 -Start` — 검증 후 서버 기동 / `-OpenBrowser` — 브라우저까지 염
  - `.\init.ps1 -Live` — **배포된 프록시까지 확인**(권장). `local.endpoint.txt` 에 `/exec` URL 필요
  - ⚠ **`init.ps1` 은 반드시 UTF-8 BOM 으로 저장할 것.** Windows PowerShell 5.1 은 BOM 없는
    `.ps1` 을 cp949 로 읽어 한글 문자열이 깨지고 파서 오류가 난다(2026-08-31 실제 발생)
- **Standard verification path**: `init.ps1` 에 포함 — 하네스 5파일 + 로그인 7파일 +
  진로상담 14파일 존재, HTML 무결성 10건, 공통자산 참조 9건, `auth.js` API 8종 + PBKDF2,
  `career.js` API 11종 + fetch 경로 + 옵시디언 스텁 + 웹검색 지시 + 출처 경로,
  프록시 예시 4종, **저장소 내 `sk-ant-` 키 문자열 검사**, 프롬프트 생성물 동기화,
  `home.html`→`career.html` 링크, JSON 파싱, `python`, 포트.
  **68개 항목 전부 통과해야 exit 0**
- **Standard start command**: `python -m http.server 8940` → http://localhost:8940/
  (`.claude/launch.json` 의 `newPrjt01-static` 과 동일 포트)
- **Current highest-priority unfinished feature**: 없음. 진로상담(`career-001`~`010`) 전부 **passing**
- **Current blocker**: 없음. 남은 미착수는 보류된 `auth-006`(서버 인증)·`auth-007`(실제 OAuth)뿐
- **운영 상태**: AI 프록시·공식자료 웹검색·옵시디언 전송·토큰 사용량 시트 기록까지 실동작 확인.
  시트 `웹도구` 열 = `basic` 실기동 확인(2026-09-01).
  ⚠ **프록시 v1.8.0(공용 탭 미러링 중단) 재배포 대기 중** — 저장소=1.8.0 / 배포=1.7.2

## 이 저장소의 성격

- **정적 HTML 앱 두 벌.** 빌드 단계 없음, `package.json` 없음, npm 사용 안 함
- **① 로그인 데모** — `index.html`(랜딩) · `login.html` · `signup.html` ·
  `home.html`(성공) · `error.html`(실패), 공통 자산 `assets/auth.css` · `assets/auth.js`
  - 계정 저장소는 **localStorage**(`np_users`) — 테스트 목적으로 사용자가 명시 허가.
    다만 **비밀번호는 평문이 아니라 PBKDF2-SHA256(10만회) + 사용자별 랜덤 솔트 해시**로 보관
  - 세션: 상태유지 켬 → `localStorage`, 끔 → `sessionStorage` (키 `np_session`)
- **② 진로상담 분석** — `career.html`(홈) · `career-step1` → `career-report1` →
  `career-step2` → `career-report2`, 공통 자산 `assets/career.css` · `assets/career.js` ·
  `assets/career-prompts.js`(자동 생성)
  - 사례 저장소는 **localStorage**(`np_career_cases`), 설정은 `np_career_config`
  - 프롬프트 원문은 `assets/prompts/*.txt` 가 단일 원본,
    `python tools/build-prompts.py` 로 `career-prompts.js` 를 재생성한다
  - AI 호출은 **프록시 경유**(POST · text/plain). 프록시 미설정 시 **모의 응답**으로만 동작
  - 프록시는 Anthropic **서버사이드 web_search 도구**로 공식자료를 조회한다.
    참고 구현 `tools/career_proxy.example.gs` (키는 스크립트 속성에만 둔다)
  - `home.html` 에서 진입한다 (로그인 필요)
- 상위 `C:\myPrjt01\CLAUDE.md` 의 워크스페이스 지침도 함께 적용된다

## Session Log

### Session 001

- **Date**: 2026-08-31
- **Goal**: 에이전트 하네스 4종 파일을 설치하고 동작시키기
- **Completed**:
  - `walkinglabs/learn-harness-engineering`(MIT) 템플릿에서 `AGENTS.md`·`CLAUDE.md`·
    `claude-progress.md`·`feature_list.json`·`init.sh` 내려받음 + `session-handoff.md` 추가
  - ⚠ 템플릿 `init.sh` 는 npm 전제(`npm install`/`npm test`/`npm run dev` 자리표시자)라
    `ENOENT: package.json` 으로 실패 → 정적 HTML 앱에 맞게 교체
  - 실패한 `npm install` 이 남긴 빈 `package-lock.json` 삭제
- **Verification run**: `bash init.sh` → 7개 항목 전부 `[OK]`, exit 0
- **Known risk**: `spec-001` 미해소 — 앱 정의가 없어 실질 작업 불가
- **Next best step**: 사용자에게 이 앱이 무엇인지 확인받기

### Session 002

- **Date**: 2026-08-31
- **Goal**: ① 일반적인 로그인 웹페이지 세트 구현 ② `init.sh` → `init.ps1` 변환(새 기능 반영)
- **Completed**:
  - ✅ **`spec-001` 해소** — 앱이 "로그인 데모"로 확정됨
  - **화면 4종 신규 작성**: `login.html`, `signup.html`, `home.html`, `error.html`
    - 로그인: 상태 유지 체크박스, 비밀번호 찾기(모달), Google 버튼(모의), Enter 키 제출
    - 회원가입: 아이디 중복확인, 비밀번호 재확인, 보기/숨김 토글
    - 결과: 성공(세션 정보 6행) / 실패(사유 표시)
  - **공통 자산 신설**: `assets/auth.css`(글래스모피즘 디자인 시스템), `assets/auth.js`(인증 로직)
  - `index.html` 에 로그인 데모 진입 버튼 추가
  - **`init.sh` → `init.ps1` 변환 완료.** 검증 항목을 7개 → **26개**로 확장해 새 기능을 반영
    (앱 파일 존재, HTML 무결성, 공통자산 참조 누락, `auth.js` API 8종, PBKDF2 해싱 존재 등)
  - `AGENTS.md`·`CLAUDE.md` 의 `./init.sh` 참조를 `.\init.ps1` 로 갱신
  - `init.sh` 제거 (변환이므로 시작 경로를 하나로 유지)
- **Verification run**:
  1. `.\init.ps1` → **26개 항목 전부 `[OK]`, exit 0**
  2. 브라우저 실기동 검증(http://localhost:8940) — 가입→로그인→홈, 실패 경로, 세션 유지,
     Google 모의, 중복가입 차단, 접근 가드까지 전 경로 통과
- **Evidence captured**:
  - `init.ps1` 실행 출력 26행
  - 저장값 확인: `salt` 존재, `hash` 44자(base64 256bit), **평문 `pass1234` 미포함(false)**
  - 상태유지 켬 → `localStorage`=true/`sessionStorage`=false, 끔 → 반대
  - 실패 로그인 → `error.html` 이동 + 세션 `null`
  - 세션 없이 `home.html` 접근 → `login.html` 로 차단
  - 로그인/회원가입/성공 화면 스크린샷 3장
- **Commits**: `65be780` — Session 003 시작 시 확인해 보니 이미 커밋되어 있었다
  (당시 기록이 뒤처져 있던 것)
- **Files or artifacts updated**:
  신규 `login.html`·`signup.html`·`home.html`·`error.html`·`assets/auth.css`·`assets/auth.js`·`init.ps1` /
  수정 `index.html`·`AGENTS.md`·`CLAUDE.md`·`feature_list.json`·`claude-progress.md`·`session-handoff.md`·`README.md` /
  삭제 `init.sh`
- **Known risk or unresolved issue**:
  - ⚠ **`init.ps1` 인코딩 함정**: BOM 없이 저장하면 PowerShell 5.1 이 cp949 로 읽어
    한글이 깨지고 파서 오류가 난다. 이번 세션에서 실제로 겪었고 UTF-8 BOM 으로 해결.
    **이 파일을 편집하는 도구가 BOM 을 떨어뜨리지 않는지 확인할 것**
  - ⚠ **인증이 전부 클라이언트 측이다** — `home.html` 의 가드는 보안 경계가 아니고,
    계정이 브라우저별로 격리된다. `auth-006`(서버 인증)이 남은 최대 과제
  - ⚠ **Google 로그인은 실제 OAuth 가 아니다**(`auth-007` 미착수). 화면에 모의라고 명시함
  - 테스트로 만든 계정은 세션 종료 시 정리했으나, 사용자가 직접 가입해 보면
    브라우저 localStorage 에 남는다 — 개발자도구에서 `np_users` 삭제로 초기화 가능
  - `AGENTS.md` 와 `CLAUDE.md` 는 여전히 내용이 거의 같다 — 규칙 변경 시 양쪽 동시 갱신 필요
- **Next best step**:
  `auth-006`(서버 기반 인증) 착수 여부를 사용자에게 확인. 데모로 충분하다면 현 상태에서
  커밋하고 종료. 계속 간다면 백엔드 선택(Node/Express, Spring Boot 등)부터 정해야 한다.

### Session 003

- **Date**: 2026-09-01
- **Goal**: 새 기능 영역 주입 — **진로상담 분석 웹페이지** 신규 구축
  (1차 입력 → 1차 분석 → 2차 추가정보 → 2차 분석, 결과 로컬 보존 + md 저장,
  로그인 성공 페이지에서 연결). `auth-006` 은 사용자 지시로 보류.
- **Completed**:
  - **입력 자료 반입**: 사용자가 준 프롬프트 4종을 `assets/prompts/` 로 복사
    (`prompt-1st.txt` 26KB · `prompt-2nd.txt` 15KB · `input-1st.txt` · `input-2nd.txt`)
  - **프롬프트 생성기**: `tools/build-prompts.py` → `assets/career-prompts.js`(21KB) 생성.
    원문은 `.txt` 가 단일 원본이고 생성물은 커밋한다 — **앱에는 빌드 단계가 없다**
  - **화면 5종 신규 작성**: `career.html`(홈·사례목록) · `career-step1.html`(학생 정보 12항목) ·
    `career-report1.html` · `career-step2.html`(경험/학교자료 있음·없음 라디오) ·
    `career-report2.html`(합본 저장 포함)
  - **공통 자산 신설**: `assets/career.css`(문서형 레이아웃·보고서 스타일),
    `assets/career.js`(사례 저장소 · AI 호출 · 자체 마크다운 렌더러 · md 저장 · 옵시디언 스텁 ·
    공통 상단바/설정 모달 주입)
  - **AI 호출 방식**: 프롬프트 복사 방식이 아니라 **프록시 경유 호출**로 구현
    (careerTest 와 동일한 형태, POST + `text/plain` 으로 GAS CORS preflight 회피).
    **프록시 주소·API 키는 추후 결정** — 미설정이면 모의 응답으로 흐름만 검증되고
    화면·md 양쪽에 모의라고 표시된다
  - **옵시디언 전송**: Local REST API 직접 호출 방침. 지금은 **버튼만 표시**하고
    `sendToObsidian()` 안에 실제 PUT 코드를 TODO 블록으로 넣어 두었다
  - `home.html` 에 진로상담 진입 카드 추가 (+ `assets/auth.css` 에 `.app-card` 스타일)
  - **`init.ps1` 검증 26개 → 53개로 확장** (진로상담 파일·자산참조·API·프롬프트 동기화·
    home 링크 검사 추가). UTF-8 BOM 유지 확인함
  - `feature_list.json` 에 `career-001`~`career-009` 주입. 기존 기능은 우선순위를 뒤로 밀고
    `auth-006` 에 보류 사유를 기록
- **Verification run**:
  1. `.\init.ps1` → **53개 항목 전부 `[OK]`, exit 0**
  2. 브라우저 실기동(http://localhost:8940) 전 경로 통과 —
     로그인 → home 진입 카드 → 사례 생성 → 1차 입력 → 1차 분석 → 2차 입력 → 2차 분석 →
     md 저장 → 옵시디언 차단 확인. 콘솔 오류 0건
- **Evidence captured**:
  - `init.ps1` 출력 53행 전부 `[OK]`
  - 1차 미리보기: 12항목이 `input-1st.txt` 순서와 1:1 일치, 미입력 9항목 `(입력 없음)` 직렬화
  - 1차 분석 → `report1` 저장(md 1109자), 보고서에 표 1개(9행)·제목 7개·인용 1개 렌더
  - 2차: 경험 “있음” → 9항목 펼침 / 학교자료 “없음” → 미리보기에 `학교자료 없음` 출력
  - md 저장 → 토스트 `진로2차_고2 A - 반도체 관심_20260901-1535.md`, 프론트매터 7줄(`mock: true`)
  - 옵시디언 전송 클릭 → 안내로 차단(`obsidianBlocked=true`)
  - 잘못된 프록시 주소 → 배지 “AI 연결됨” + 실패 화면 “프록시에 연결하지 못했습니다…”
  - 설정 모달: 우측 상단 X · 하단 취소/저장 · ESC 닫기 전부 동작, 옵시디언 입력란 disabled
  - 스크린샷: home 진입 카드 / career 홈 / 1차 입력 / 1차 결과 / 2차 입력 / 2차 결과 /
    실패 화면 / 설정 모달
- **Commits**: (이 세션 종료 시 커밋 예정)
- **Files or artifacts updated**:
  신규 `career.html`·`career-step1.html`·`career-report1.html`·`career-step2.html`·
  `career-report2.html`·`assets/career.css`·`assets/career.js`·`assets/career-prompts.js`·
  `assets/prompts/*.txt`(4)·`tools/build-prompts.py` /
  수정 `home.html`·`assets/auth.css`·`init.ps1`·`feature_list.json`·`README.md`·
  `claude-progress.md`·`session-handoff.md`
- **Known risk or unresolved issue**:
  - ⚠ **`career-008` 미결** — AI 프록시 주소·API 키 미정. 지금 결과는 전부 모의 응답이다.
    상담 자료로 쓰면 안 된다(화면에도 경고 표시)
  - ⚠ **`career-009` 미결** — 옵시디언 접속 주소·API 키·볼트 폴더 규칙 미정.
    자체서명 인증서 신뢰와 플러그인 CORS 허용 여부를 먼저 확인해야 한다
  - ⚠ **careerTest 의 `career_proxy.gs` 에 Anthropic API 키가 평문으로 들어 있다.**
    이 저장소로 그대로 복사하지 말 것. (그 파일은 careerTest 의 `.gitignore` 대상)
  - ⚠ 프롬프트가 요구하는 **공식자료 웹검색**은 프록시 구현에 달려 있다.
    검색 도구 없이 호출하면 “확인 불가” 항목이 대량으로 나온다 — 프록시 설계 시 고려할 것
  - `assets/career-prompts.js` 는 생성물이다. `.txt` 를 고치면
    `python tools/build-prompts.py` 를 반드시 다시 돌릴 것 (`init.ps1` 이 시각을 비교해 잡아낸다)
  - 브라우저 패널의 스크롤 캡처가 긴 문서에서 빈 화면으로 찍힌다 — **앱 문제가 아니라
    캡처 도구 한계**다(순수 텍스트 파일에서도 동일 재현). 검증은 DOM 판독으로 했다
  - `AGENTS.md` 와 `CLAUDE.md` 는 여전히 내용이 거의 같다 — 규칙 변경 시 양쪽 동시 갱신 필요
- **Next best step**:
  `career-008`(AI 프록시 주소·API 키) 확정. 이것만 들어오면 진로상담이 실제로 동작한다.
  그다음이 `career-009`(옵시디언). `auth-006` 은 보류 상태 유지.

#### Session 003 후속 — 공식자료 웹검색 (`career-010`)

- **문제**: 진로상담 프롬프트는 커리어넷·KOSIS·어디가·Q-Net 등 공식자료 확인을 전제로 하는데,
  검색 도구 없는 프록시로 호출하면 “확인 불가”가 대량으로 나온다 (Session 003 종료 시 남긴 리스크).
- **택한 해법**: 별도 검색 API를 붙이지 않고 **Anthropic 서버사이드 web_search 도구**를
  프록시에서 켠다. 검색이 Anthropic 서버에서 실행되므로 추가 인프라가 없다.
  - 도구: `web_search_20260209`(동적 필터링) + `web_fetch_20260209`.
    동적 필터링이 내장이라 `code_execution` 을 따로 선언하면 안 된다
  - 서버 도구 루프는 10회에서 `stop_reason: pause_turn` 으로 끊긴다 →
    프록시가 user + assistant 응답을 그대로 되돌려 보내 이어간다(최대 4회).
    “계속하세요” 같은 메시지를 덧붙이면 안 된다
  - 서버 도구 오류는 예외가 아니라 200 응답 안에 온다 —
    `web_search_tool_result.content` 가 성공이면 배열, 오류면 `{error_code}` 객체
- **구현**
  - 신규 `tools/career_proxy.example.gs` — 웹검색·이어달리기·출처수집·거절(refusal) 처리를
    포함한 참고 프록시. **API 키는 스크립트 속성에만** 두고 소스에 넣지 않는다
  - **careerTest 와 배포를 공유할 수 있게 GET/POST 겸용으로 만들었다**(사용자 요청).
    `doGet` 은 기존 `career_proxy.gs` ver4.1 과 동작이 같고(고정 system·HTML·검색 없음),
    `doPost` 를 **추가**해 진로상담을 받는다. 하나의 `/exec`, 하나의 API 키.
    GET 으로 합칠 수 없는 이유: 1차 프롬프트가 26KB 라 URL 쿼리에 실을 수 없고,
    careerTest 의 system 은 소스 고정 + HTML 출력이다
  - `career.js` — 요청에 `web_search` / `search_max_uses` / `allowed_domains` 를 싣고,
    응답의 `sources` · `searches` · `truncated` 를 사례에 함께 저장.
    `OFFICIAL_DOMAINS` 16개 기관, `renderSources()` 추가
  - 설정 모달에 “② 공식자료 웹검색” 절 추가, 상단에 웹검색 상태 배지 추가
  - 결과 화면에 **“참고한 웹 출처”** 카드 + 출처 0건 경고 + max_tokens 잘림 경고
  - 기본 모델을 `claude-sonnet-5` → **`claude-opus-5`** 로 변경
    (`web_search_20260209` 지원 모델이며 리서치 품질이 이 작업의 핵심)
  - `init.ps1` 53 → **59개 항목**. 새 검사: 웹검색 지시 · 도메인/출처 경로 ·
    프록시 예시 4종 · **저장소 내 `sk-ant-` 키 문자열 검사** ·
    **careerTest GET 경로 보존 여부**(배포를 덮어써 careerTest 를 죽이는 사고 방지)
- **⚠ 판단이 필요했던 지점 — 도메인 화이트리스트 기본값**
  공식 도메인으로 검색을 제한하면 프롬프트의 출처 규정에는 맞지만,
  **대학 입학처는 학교마다 도메인이 달라** STEP 7-3(대학 정보·입시결과)이 통째로 막힌다.
  그래서 화이트리스트는 **옵션으로 두고 기본값을 꺼짐**으로 했다. 화면에도 경고를 넣었다.
- **Verification run**: `.\init.ps1` → **59개 항목 전부 `[OK]`, exit 0**
- **Evidence captured**
  - fetch 스텁으로 실제 payload 확인 — `web_search=true`, `search_max_uses=12`,
    `allowed_domains` 16건, `model=claude-opus-5`
  - 출처 3건 응답 → “웹검색 5회로 3건의 출처를 참고했습니다” + 출처 카드 3개 렌더(스크린샷)
  - `sources=[]` → “웹검색 흔적이 없습니다” 경고 / `mock=true` → 출처 카드 숨김
  - 설정 모달 3개 절(AI 호출 · 공식자료 웹검색 · 옵시디언) 렌더 확인(스크린샷)
  - 배지 상태 전환 확인 — 웹검색 켜짐 / 웹검색 · 공식자료만 / 웹검색 꺼짐
#### Session 003 후속 2 — 실행시간 초과 대응 (프록시 배포 후 발견)

- **증상**: 배포 후 `testProxy()` 실행이 **비정상적으로 오래 걸리고 끝나지 않음**
- **원인 (겹침)**
  - `claude-opus-5` 는 **적응형 사고가 기본 ON**, `effort` 기본값 `high` → 한 번 호출이 수 분
  - 거기에 `web_search` + `web_fetch` 서버 루프가 얹힘
  - **`MAX_CONTINUATIONS = 4`** → 무거운 호출을 최대 **5회 직렬** 반복
  - Apps Script 는 개인 계정 기준 **실행 6분에서 강제 종료**, GAS 는 스트리밍 불가
  → 즉 "무거운 요청 1개"가 아니라 "무거운 요청 5개 직렬"이라 한도 초과가 사실상 확정이었다
- **조치**
  - 프록시: `DEFAULT_EFFORT='low'`, `MAX_CONTINUATIONS 4→1`,
    **`DEADLINE_MS`(4분) 시간 가드** — 넘기면 스스로 끊고 받은 만큼 반환(`incomplete: true`),
    `elapsed_ms`·`effort` 를 응답에 실어 측정 가능하게 함
  - `output_config: {effort}` 를 요청에 추가(GA, 베타헤더 불필요)
  - 점검 함수를 **단계별로 분리** — `test1_key`(검색 없음, 수 초) →
    `test2_search`(검색 1회) → `test3_load`(검색 4회) → `test4_careertest`(GET 회귀).
    어디서 느려지는지 좁혀 나가도록 함
  - 클라이언트: `effort` 설정 추가(기본 low, 모달에서 선택), 기본 검색 횟수 12→6,
    결과 화면에 **“검색을 끝까지 못 돌렸습니다” 경고 + 소요 시간** 표시
  - `init.ps1` 59 → **62개 항목**. 신규: `effort` 전달 여부, 프록시의 시간가드/`output_config`,
    **`MAX_CONTINUATIONS` 상한(0~2) 검사** — 나중에 누가 늘려 놓으면 같은 사고가 재발한다
- **Verification run**: `.\init.ps1` → **62개 항목 전부 `[OK]`, exit 0**
- **Evidence captured**
  - fetch 스텁: 요청에 `effort=low`, `search_max_uses=6` 실림 확인
  - `incomplete:true, elapsed_ms:241000` 응답 → 결과 화면에 경고 + `(241.0초 소요)` 표시 확인
  - `node --check` 구문 통과
- **아직 미검증**: 실제 프록시에서 얼마나 걸리는지. `test2_search` 시간을 재서
  `검색 1회 시간 × 검색 횟수` 로 예상치를 잡을 것

#### Session 003 후속 3 — 기본 모델 Haiku 4.5 로 변경 (사용자 지시)

- **지시**: "Opus 로 안 해도 되지 않나" → 기본 모델을 `claude-haiku-4-5` 로
- **동의하는 이유**: 5배 저렴하고 훨씬 빨라 **6분 한도 문제에 직접 도움**이 된다
- ⚠ **그냥 모델 문자열만 바꾸면 안 된다** — Haiku 4.5 는 요청 형태가 다르다
  - `web_search_20260209`(동적 필터링)은 Opus 5/4.8/4.7/4.6, Sonnet 5/4.6 전용 →
    Haiku 는 기본형 `web_search_20250305` / `web_fetch_20250910` 를 써야 한다
  - **`output_config.effort` 를 보내면 오류가 난다**(Haiku 4.5 · Sonnet 4.5)
  - 둘 다 그대로 두면 400 이 났을 것이다
- **조치**
  - 프록시에 `supportsNewWebTools_()` · `supportsEffort_()` 두 헬퍼를 넣어 모델별로 분기.
    응답에 `model` · `web_tools`(basic|v2026) 를 실어 어떤 형태로 나갔는지 확인 가능
  - 클라이언트 기본 모델 `claude-opus-5` → `claude-haiku-4-5`,
    모델 입력을 자유 텍스트 → **선택 목록**(Haiku 4.5 / Sonnet 5 / Opus 5)으로 바꾸고
    "Haiku 는 effort 를 받지 않는다" 안내를 붙임
  - `init.ps1` 62 → **63개 항목**. 신규: 프록시의 모델별 분기 존재 검사
- **Verification run**: `.\init.ps1` → **63개 항목 전부 `[OK]`, exit 0**
- **Evidence captured**
  - 분기 로직 단위 확인 — haiku-4-5: `basic`/effort=false, sonnet-5·opus-5: `v2026`/effort=true,
    sonnet-4-5: `basic`/effort=false, opus-4-5: `basic`/effort=true
  - fetch 스텁: 요청에 `model=claude-haiku-4-5` 실림 확인
  - 설정 모달에 모델 선택 3종 + Haiku effort 안내 렌더(스크린샷)
#### Session 003 후속 3-b — 클라이언트 무한 대기 결함 (내 실수)

- **증상**: 프록시 변경 이후 웹페이지가 **한 시간 동안 응답 없음**
- **원인**: `Career.callAI` 의 `fetch` 에 **타임아웃이 없었다.**
  Apps Script 는 6분에 강제 종료되는데 그때 응답을 못 돌려주면
  브라우저 `fetch` 는 무한정 기다린다. 서버가 죽어도 화면이 끝나지 않았다
- **판단 근거**: 한 시간은 물리적으로 GAS 실행일 수 없다(6분 상한).
  따라서 "응답 없음"은 서버가 도는 게 아니라 **기다리는 쪽이 안 끊는 것**이었다
- **조치**: `AbortController` + `timeoutSec`(기본 400초) 도입.
  만료 시 무엇을 줄여야 하는지(검색 횟수·effort·max_tokens)까지 안내하고,
  설정 모달에 "응답 대기 상한(초)" 입력 추가
- **Evidence**: 응답하지 않는 엔드포인트를 흉내내 `timeoutSec:3` 으로 호출 →
  **3015ms 만에 중단**, 메시지 "3초 안에 응답이 오지 않아 중단했습니다" + 줄일 항목 안내 확인
- **⚠ 아직 원인 미확정**: 변경 **전**(Opus 5 + `web_search_20260209`)에는 결과가 나왔는데
  변경 **후**(Haiku 4.5 + `web_search_20250305`)에 안 나온다면,
  **Haiku 4.5 + 기본형 웹검색 조합**이 의심된다. 다음 세션에서
  `test1_key`(검색 없음) → `test2_search`(검색 1회) 순으로 좁힐 것.
  모델을 Sonnet 5 로 올리면 변경 전 조합(v2026 도구 + effort)으로 돌아간다

#### Session 003 후속 4 — 옵시디언 연결 실측 및 구현 (`career-009`)

- **1차 실측(플러그인 설치 전)**: 27123·27124 모두 ERR_CONNECTION_REFUSED,
  `Test-NetConnection` 도 listening=False. 볼트 `C:\myPrjt01\myWorkspace01` 의
  `community-plugins.json` 확인 결과 `obsidian-local-rest-api` **미설치** 확정.
  (현재 떠 있던 27200 은 별개의 `mcp-tools-istefox` 이며 CORS 헤더가 없어 브라우저에서 불가)
- **설치가 안 되던 원인**: 레지스트리에서 **표시 이름이 바뀌었다** —
  id 는 `obsidian-local-rest-api` 그대로지만 이름이 **`Local REST API with MCP`**(저자 Adam Coddington).
  "Local REST API" 로 찾으면 다른 것으로 보여 지나치게 된다.
  네트워크는 정상이었다(레지스트리·GitHub 모두 200)
- **계측기 신설**: `tools/obsidian-check.html` — 진로상담 앱과 **같은 출처**에서
  도달 → CORS → 인증서 → 인증(preflight) → 쓰기 5단계를 판정.
  핵심 설계는 **`no-cors` 프로브로 연결거부와 CORS 차단을 구분**한 것 —
  둘 다 `fetch` 에서는 똑같이 `Failed to fetch` 로 보여 원인 특정이 안 된다
- **2차 실측(설치 후) — ①~④ 전부 통과**
  - ① 27123 응답 17ms  ② ③ CORS·인증서 통과 HTTP 200 (플러그인 v5.1.0)
  - ④ Authorization preflight + 키 인증 HTTP 200
- **구현**: `sendToObsidian()` 의 TODO 블록을 열어 실제 `PUT` 수행.
  `testObsidian()`(쓰기 없이 상태·인증만 확인) 추가, 설정 모달의 옵시디언 입력란 활성화 +
  **연결 테스트** 버튼, 기본 주소를 실측 통과한 `http://127.0.0.1:27123` 으로
- **⚠ 판단**: HTTPS(27124)를 기본값에서 뺐다. 자체서명 인증서라 브라우저 `fetch` 가 거부하는데,
  인증서 예외 등록은 사용자가 매번 겪을 마찰이다. 로컬 전용이므로 HTTP 가 합리적이다
- **Verification run**: `.\init.ps1` → **64개 항목 전부 `[OK]`, exit 0**
- **Evidence captured**
  - 앱에서 잘못된 키로 호출 → **HTTP 401** 수신. 요청이 실제로 플러그인에 닿고
    CORS·preflight 를 통과했다는 직접 증거다
  - 없는 포트(27999) → "옵시디언에 연결하지 못했습니다" 안내
  - 미설정 상태 → 전송 대신 설정 안내로 차단
  - URL 생성: baseUrl 끝 슬래시·folder 앞뒤 슬래시 정규화 + 한글 인코딩 확인 →
    `/vault/진로상담/진로1차_고2 A - 반도체_20260901-1535.md`, PUT, text/markdown
  - 설정 모달 렌더 확인(입력란 활성, 연결 테스트 버튼, 사용 토글) — 스크린샷
- **⑤ 실제 쓰기까지 통과 — `career-009` passing (2026-09-01 17:27)**
  - 사용자가 설정에 키를 넣고 [옵시디언으로 전송] 실행 → 성공
  - 볼트에서 직접 확인: `C:\myPrjt01\myWorkspace01\진로상담\` 폴더가 **PUT 시점에 자동 생성**되고
    `진로1차_2학년 김현수_20260901-1727.md`(2412B) 생성.
    프론트매터 7줄(`mock: true` 포함) 정상 기록
  - 폴더를 미리 만들 필요가 없다는 것도 확인됨 — 플러그인 `main.js` 의
    `vault.createFolder(dirname(filePath))` 경로가 동작
- **⚠ 보안 메모**: API 키가 `localStorage`(`np_career_config`)에 평문으로 저장된다.
  로컬 전용 키이고 사용자 브라우저에만 남지만 공용 PC 에서는 쓰지 말 것. 화면에도 경고를 넣었다

- **⚠ 남는 품질 리스크**: 이 프롬프트는 `[확인]`/`[해석]`/`[제안]` 구분, 근거 없는 수치 금지,
  "확인 불가" 표시 같은 **엄격한 지시 준수**를 요구한다. Haiku 가 이걸 지키는지는
  **실제 출력으로 확인해야 한다.** 흐트러지면 Sonnet 5 로 올릴 것 — 설정에서 바로 바꿀 수 있다

- **남는 리스크**
  - **실제 프록시로는 아직 못 돌려봤다.** 배포 후 확인할 것:
    ① Apps Script 6분 실행 한도 — 검색이 길어지면 초과할 수 있다
    ② `max_tokens` 부족으로 잘리는지(잘림 경고가 뜬다)
    ③ 검색 12회가 적절한지
    ④ 기존 careerTest 가 계속 도는지(같은 배포를 공유할 경우 — 반드시 "새 배포"가 아니라
      "배포 관리 → 새 버전"으로 갱신해야 /exec URL 이 유지된다)
  - 프록시 응답이 `sources` 를 안 주는 구버전이면 화면이 출처 0건 경고를 띄운다 —
    오작동이 아니라 의도된 경고다

### Session 004 — 실제 연결과 운영 안정화

- **Date**: 2026-09-01
- **Goal**: 프록시를 실제로 배포해 진로상담을 실동작시키고, 그 과정에서 드러나는
  결함을 잡아 `career-008`·`career-009` 를 닫는다.
- **결과**: **진로상담 전 기능 passing.** blocked 0건.

#### 실제로 붙인 것

| 항목 | 결과 |
|---|---|
| AI 프록시 | careerTest Apps Script 배포·API 키를 공유. `doGet`(careerTest) + `doPost`(진로상담) 겸용 |
| 공식자료 웹검색 | 서버사이드 `web_search` — 1차에서 5~6회 수행 확인 |
| 옵시디언 전송 | Local REST API 27123 직접 호출. 볼트에 노트 생성 확인 |
| 토큰 사용량 | careerTest 시트에 전용 탭 + 공용 탭 미러링. 5건 기록 확인 |

#### 실측값 (2026-09-01 20:11~20:15, 시트에서 직접 확인)

- 1차: 입력 88,802 + 출력 18,223 = **107,025** 토큰 / 검색 5회 / **177초**
- 2차: 입력 64,714 + 출력 13,937 = **78,651** 토큰 / **117.8초**
- 1사례(1+2차)당 Haiku 4.5 기준 대략 **$0.2~0.25(300원대)**
- 입력 토큰이 큰 이유는 **웹검색 결과가 컨텍스트에 누적**되기 때문이다

#### 이 세션에서 잡은 결함 (전부 내 실수였다)

1. **클라이언트 무한 대기** — `fetch` 에 타임아웃이 없어 서버가 죽어도 화면이 안 끝났다.
   실제로 한 시간 매달렸다. → `AbortController` + 400초 상한
2. **기본값을 올려도 저장된 설정이 이긴다** — `maxTokens` 기본값만 올리고 마이그레이션을
   안 넣어 기존 사용자에게 적용되지 않았다. → 저장값이 기본값보다 작으면 승격
3. **1차만 한도가 낮았다** — 2차는 12000 으로 올리고 1차는 8000 그대로. 1차가 더 긴데.
4. **모의 응답이 경고 없이 볼트로 나갔다** — 사용자가 모의 결과를 실제로 착각.
   → 내보내기 전 확인창, 2차 입력 화면에 모의 1차 경고
5. **시트 실패를 조용히 삼켰다** — `try/catch` 가 원인을 숨겨 "안 쌓인다"를 알 수 없었다.
   → 실패 사유를 응답·화면에 노출, `test5a_sheetRaw` 로 예외를 그대로 터뜨림
6. **경고 순서가 거꾸로** — 근본 원인(프록시 낡음)이 잘림 경고 아래 있어 헛수고를 시켰다
7. **`web_tools` 로그 반전** — 이어쓰기에서 `tools` 를 비우는 바람에 검색을 했는데도
   `off` 로 기록됐다. → 최초 설정값을 따로 잡아 기록

#### 재발 방지로 넣은 장치

- **프록시 버전 관리** — `.gs` 첫머리 버전·날짜·변경이력, `/exec` 상태 응답에 버전,
  클라이언트가 기대 버전과 대조해 **"프록시가 낡았습니다"** 경고.
  `init.ps1` 이 `.gs` 와 `career.js` 의 버전 불일치를 실패시킨다
  → 실제로 이 경고가 "1차가 왜 계속 잘리는가"를 진단해 냈다
- **잘린 응답 자동 이어쓰기** — 프리필로 끊긴 지점부터 이어 쓴다(최대 3회).
  모델별 프리필 지원 여부를 가려서 시도한다
- **입력 드롭다운화** — 학교급 연동(중학교 성취도 / 고교 등급), 진학연도 자동 계산.
  프롬프트의 일관성 검증에 걸릴 입력 오류를 원천 차단한다
- `init.ps1` **26 → 68개 항목**

#### Verification run

1. `.\init.ps1` → **68개 항목 전부 `[OK]`, exit 0** (blocked 0건)
2. 실기동 전 경로 통과 — 1차 입력 → 분석(검색 5회) → 2차 입력 → 분석(STEP 11까지) →
   md 저장 → 옵시디언 전송 → 시트 기록
3. 구글 시트를 Drive 커넥터로 직접 읽어 5건 기록 확인

#### 남은 리스크

- ⚠ **Haiku 4.5 의 지시 준수 한계.** 중2인데 "2등급", 진학연도 2028 같은 모순을
  프롬프트가 요구하는 `[확인 필요]` 로 잡아내지 못했다. 입력 드롭다운으로 발생을 줄였지만
  모델 자체의 한계는 남는다. 품질이 중요하면 설정에서 **Sonnet 5** 로 올릴 것
- ⚠ **공용 `토큰로그` 탭의 합계 열은 신뢰하지 말 것.** careerTest 기존 행부터
  입력+출력과 합계가 안 맞는 경우가 있다. 정확한 값은 **전용 탭**을 볼 것
- ⚠ 프록시 수정 시 **배포 관리 → 새 버전**. "새 배포"는 URL 이 바뀌어 careerTest 가 끊긴다
- 시트 ID 가 저장소 소스에 있다. 공개 전환 시 `DEFAULT_SHEET_ID` 를 비우고 스크립트 속성으로

#### Next best step

진로상담은 실사용 가능한 상태다. 다음 후보는 셋 중 하나 —
① 실제 학생 사례로 운영해 보며 프롬프트·모델 조정
② 보류된 `auth-006`(서버 인증) 재개
③ 사용량이 커지면 프록시를 Apps Script 밖(실행 한도 없는 런타임)으로 이전

### Session 005 — 하네스 자체 보강

- **Date**: 2026-09-01
- **Goal**: Session 004 에서 반복된 결함들이 왜 늦게 발견됐는지를 하네스 문제로 보고,
  같은 종류가 다시 늦게 발견되지 않도록 검증 경로를 넓힌다. 앱 기능은 건드리지 않았다.
- **결과**: `setup-003`·`setup-004` passing. `.\init.ps1` 68 → **73개 항목**, exit 0.

#### 먼저 한 일 — 오늘 이전 상태 보관

- 태그 `pre-2026-09-01` → `65be780` (원격 push 완료)
- `C:\myPrjt01\_backup\newPrjt01-harness-2026-08-31_65be780\` — 하네스 8파일 원본
- `C:\myPrjt01\_backup\newPrjt01-full-2026-08-31_65be780.zip` — 저장소 전체

#### 무엇이 문제였나

Session 004 의 손실은 대부분 "코드가 틀렸다"가 아니라 **"틀린 걸 늦게 알았다"** 였다.

| 사건 | 왜 늦게 알았나 |
|---|---|
| 낡은 프록시가 계속 돌았다 | 검증이 저장소 안의 텍스트만 봤다. 배포본은 아무도 안 봤다 |
| 보고서 끝단 잘림이 4번 재발 | 완결성 확인이 사람 눈에만 있었다 (a17e853, fa7cb8f, ee933d2, 281e859) |
| 모의 응답이 볼트로 나갔다 | 산출물을 기계가 검사하지 않았다 |

#### 넣은 것

1. **`.\init.ps1 -Live`** — `local.endpoint.txt` 의 `/exec` 를 실제로 GET 해서
   응답 `version` 과 저장소 `PROXY_VERSION` 을 대조한다. 재배포 누락을 세션 시작에 잡는다.
2. **`tools/check-report.py`** — 저장된 보고서 md 검사.
   1차는 A~L 섹션 + 출처 구분 3개, 2차는 STEP 1~11, 양쪽 다 면책 문장이
   **문서 끝 25줄 안에** 있어야 통과. 모의 응답 표시·깨진 문자·과소 분량도 실패 처리.
3. **근거 없는 `passing` 을 실패로** — `passing_requires_evidence` 규칙을 init 이 집행한다.
4. **`.gitignore` 신설 + 검사** — `career_proxy.gs`(API 키), `local.endpoint.txt`,
   저장된 보고서(학생 개인정보)가 커밋되는 경로를 막는다. 작업트리 dirty 여부도 알려준다.
5. **인코딩 검사** — 텍스트 파일의 U+FFFD 스캔 + `init.ps1` 자신의 BOM 확인.

#### 실제로 돌린 검증

1. `.\init.ps1` → 73개 항목 [OK], exit 0
2. `.\init.ps1 -Live` (엔드포인트 파일 없음) → `[FAIL] -Live 인데 local.endpoint.txt 이 없다`
3. `.\init.ps1 -Live` (없는 /exec) → `[FAIL] 배포본에 닿지 못함: (404)` — HTTP 경로 실행 확인
4. `.\init.ps1 -Live` (실제 `/exec`) → `[FAIL] 배포본이 낡았다 — 배포=1.7.1 / 저장소=1.7.2` — 실제 불일치 검출
5. `check-report.py` 실제 저장본 2건(19,678자 / 15,077자) → 전부 통과, exit 0
6. `check-report.py` 2차 60% 절단본 → `단계 누락: STEP 10, STEP 11` + `면책 문장이 없다`, exit 1
7. 인코딩 검사가 `check-report.py` 안의 U+FFFD 리터럴을 실제로 찍어냄 → `chr(0xFFFD)` 로 수정

#### 남은 리스크

- ✅ **`-Live` 실배포 실측 완료 — 그리고 첫 실행에서 바로 걸렸다.**
  `/exec` 응답 `version=1.7.1`, 저장소 `1.7.2` →
  `[FAIL] 배포본이 낡았다 — 배포=1.7.1 / 저장소=1.7.2`
  - **운영 상태**: 배포본에 v1.7.2(이어쓰기로 `tools` 를 비우는 바람에 시트 로그의
    `web_tools` 가 `off` 로 뒤집히던 정정 + 이어쓰기 횟수 기록)가 빠져 있다.
    분석 품질에는 영향이 없고 **시트 로그 열이 틀리게 적힌다**. 재배포하면 해소
  - 이 상태에서는 앱 결과 화면에도 "프록시가 낡았습니다" 경고가 뜬다
    (`career.js` 의 `EXPECTED_PROXY_VERSION` = 1.7.2)
- ⚠ `check-report.py` 의 기대값은 프롬프트의 **출력 형식**에 묶여 있다.
  `assets/prompts/*.txt` 의 A~L / STEP 구조를 바꾸면 검사기도 같이 고칠 것
- 문서 비대화는 손대지 않았다 — `claude-progress.md` 400줄 초과, `feature_list.json` 26KB.
  아카이브 정책은 이력 손실 우려가 있어 보류(사용자 판단 대기)

#### Next best step

Session 004 의 후보가 그대로 유효하다. 하네스 쪽으로는 위 "남은 리스크" 첫 줄
(진짜 엔드포인트로 `-Live` 실측)이 가장 값싼 다음 걸음이다.

### Session 006 — CLAUDE.md 보강 · 프록시 재배포

#### 한 일

1. **`CLAUDE.md` 재작성** (`f3cf2d2`). 하네스 템플릿 그대로여서 이 저장소에 대한
   정보가 없었다 — 운영 규칙은 유지하고 **Commands / Architecture / 자주 밟는 지뢰**를
   앞에 넣었다. `AGENTS.md` 에만 있던 지뢰(BOM, 재배포, `check-report.py`)를
   `CLAUDE.md` 에서도 볼 수 있게 했다.
2. **Apps Script 재배포** (사용자 수행) — Session 005 가 `-Live` 로 잡아낸
   배포 1.7.1 / 저장소 1.7.2 불일치를 해소했다.

#### 검토했으나 하지 않은 것

- **프록시 예시의 `test*` 함수 제거** — 사용자 제안, 검토 후 **보류로 결정**.
  `test5_sheet` 는 테스트가 아니라 **`SpreadsheetApp` 권한 승인 장치**다(편집기에서
  한 번 돌려야 동의 창이 뜬다). `init.ps1` 도 존재를 검사하고, `/exec` 는
  `doGet`/`doPost` 만 노출하므로 런타임 비용이 0이다. 별도 `.gs` 분리도 검토했으나
  **붙여넣을 파일이 둘로 늘어 "한쪽만 갱신" 실패 모드를 하나 더 만든다**는 이유로 제외.

#### Verification run

- `.\init.ps1` → 전 항목 `[OK]`, exit 0 (CLAUDE.md 수정 후)
- `.\init.ps1 -Live` → **`[OK] 배포본 살아있음 · 버전 일치 (1.7.2)`**, FAIL 0건, exit 0
  - Session 005 의 유일한 🔴 가 닫혔다. 저장소·클라이언트 기대·배포본 세 버전이 일치한다

#### 남은 리스크

- `check-report.py` 기대값이 프롬프트 출력 형식에 묶여 있는 건 그대로다
- 문서 비대화도 그대로 — `claude-progress.md` / `feature_list.json`. 아카이브 정책 미결
- ~~**미검증**: 재배포 후 시트의 `web_tools` 열~~ — **확인 완료(2026-09-01).**
  실기동 검증 1회 후 시트 전용 탭 `진로상담 토큰로그` 의 **`웹도구` 열 = `basic`**.
  v1.7.2 의 로그 정정이 실효했다. 이어쓰기 구간에서 `tools` 를 비워 `off` 로 뒤집히던
  증상(Session 004 의 결함 7번)이 닫혔다. Haiku 4.5 기본이므로 `basic` 이 정상값이다

#### 추가 — `/exec` URL 유출 방지 검사 (`init.ps1` 5c-5)

GitHub Pages 로 연 사이트에서 "프록시 URL 이 없다"는 보고에서 나왔다. 원인은 정상 동작이다 —
설정은 `np_career_config`(오리진별 `localStorage`)에 있어 주소가 다르면 비어 있다.
`local.endpoint.txt` 는 앱이 읽지 않는다(`init.ps1 -Live` 전용).

**진짜 위험은 그다음 행동**이다. 브라우저마다 다시 입력하기 귀찮으면
`DEFAULT_CONFIG.endpoint` 에 URL 을 박고 싶어지는데, GitHub Pages 는 공개라
소스가 그대로 노출된다. `/exec` URL 만 알면 **누구나 이 계정의 API 키로 호출**하고
요금은 이쪽에 붙는다. 기존 `sk-ant-` 검사로는 못 잡는다 — 키가 아니라 URL 이라서다.

검사는 배포 ID 20자 이상만 본다. 문서·플레이스홀더의 `.../exec` 는 걸리지 않는다.
`career_proxy.gs`(gitignore 대상, 실 파일)는 제외한다.

- 양성 시험: `_exec_probe.js` 에 실제 `/exec` URL 을 넣고 실행 →
  `[FAIL] 소스에 /exec URL 이 박혀 있음: _exec_probe.js`, exit 1. 확인 후 삭제
- 음성 시험: `career.js` 의 자리표시자 2곳(`endpoint` 주석, 입력 placeholder)은 통과

문서에도 같이 적었다 — `README.md`(프록시 절), `CLAUDE.md`(지뢰), `session-handoff.md`(바꾸면 안 되는 것).

#### 추가 — 공용 `토큰로그` 탭 미러링 중단 (프록시 v1.8.0)

사용자 요청. 한 번의 분석이 `진로상담 토큰로그` 와 공용 `토큰로그` 두 탭에 **이중으로**
남는 것이 혼란스럽다는 판단이다. v1.5.0 에서 careerTest 합계에 진로상담 사용량을
포함시키려고 넣었던 기능인데, 그 대가가 이중 기록이었다.

- `MIRROR_TO_SHARED` 를 `false` 로. **코드는 지우지 않고 남긴다** — 되돌릴 때
  값 하나만 바꾸면 되고, 지웠다가 다시 쓰면 열 형식을 또 맞춰야 한다
- `PROXY_VERSION` 1.7.2 → **1.8.0**, `career.js` 의 `EXPECTED_PROXY_VERSION` 도 같이
- `init.ps1` 검사를 **의도에 맞게 바꿨다** — "미러링이 있는가"에서
  "`MIRROR_TO_SHARED` 가 `false` 인가"로. 느슨하게 만든 게 아니라 반대 방향을 집행한다.
  플래그가 나중에 `true` 로 되돌아오면 실패한다

**트레이드오프(기록해 둔다)**: careerTest 쪽 합계·차트에 진로상담 사용량이
더 이상 잡히지 않는다. 두 앱을 합산해서 보려면 전용 탭을 따로 더해야 한다.

#### Verification run (v1.8.0)

- `.\init.ps1` → 전 항목 `[OK]`, exit 0
  - `[OK] 공용 탭 미러링 꺼짐 (전용 탭에만 기록 — 이중 기록 없음)`
  - `[OK] 프록시 버전 일치 (1.8.0)`
- `.\init.ps1 -Live` → **`[FAIL] 배포본이 낡았다 — 배포=1.7.2 / 저장소=1.8.0`**, exit 1
  - **의도된 실패다.** 재배포 전까지 이 상태가 정상이며, 버전 가드가 작동한다는 증거다
  - 재배포 후 `-Live` 가 통과하면 닫힌다

#### Next best step

**재배포가 유일하게 열린 항목이다** (배포 관리 → 편집 → 새 버전 → `-Live` 재확인).
그 뒤 실기동 1회로 공용 탭에 새 행이 안 붙는지 눈으로 확인하면 완전히 닫힌다.

그 외에는 아래와 같다.

**현재 범위에서 열린 항목이 없다.** 프록시 버전 3중 일치(저장소·클라이언트 기대·배포본
= 1.7.2), `웹도구` 열 정상, `[FAIL]` 0건.

남은 것은 성격이 다른 셋뿐이다.

1. 보류된 `auth-006`(서버 인증) · `auth-007`(실제 OAuth) — 클라이언트 인증의 한계를
   실제로 걷어내려면 이쪽이다. 사용자 판단 대기
2. 문서 비대화 — `claude-progress.md` 500줄 초과, `feature_list.json` 26KB.
   아카이브 정책은 이력 손실 우려로 계속 보류 중
3. 품질 리스크(Haiku 4.5 지시 준수)는 코드로 닫을 수 없다 — `session-handoff.md` 참고


### Session 007 — '예시 채우기' 버튼 위치 수정

사용자 지적: "newPrjt02 처럼 예시 입력 기능을 여기서도 구현해 달라. 있었는데 현재론
안 보인다." 확인해 보니 기능 자체는 이미 있었다 — 코드가 지워진 게 아니라
**보이지 않는 위치**에 있었다.

#### 원인

`career-step1.html`·`career-step2.html` 모두 '예시 채우기' 버튼이 **맨 아래**
("보낼 내용 미리보기" 카드 안, [1차/2차 분석 실행]·[임시 저장] 옆)에만 있었다.
1차는 필수 3개 + 선택 9개 필드, 2차는 여러 카드를 다 스크롤해야 나오는 위치라,
페이지를 열자마자 보이는 것과는 거리가 멀었다. "있었는데 안 보인다"는 말 그대로였다.

newPrjt02(별도 저장소, 이 앱을 프롬프트 복사·붙여넣기 방식으로 다시 만든 버전)에서는
같은 버튼을 **폼 진입 전, steps 인디케이터 바로 아래**에 둬서 스크롤 없이 보이게
했었다. 이번에 이 저장소에도 같은 배치를 적용했다.

#### 한 일

- `career-step1.html` · `career-step2.html`: `#sampleBtn` 마크업을 하단 버튼줄에서
  제거하고, `<div class="steps">` 바로 다음(`<form>` 이전)으로 옮겼다.
  이벤트 바인딩은 `id` 기준이라 JS 는 손대지 않았다 — 위치만 바뀌었다
- 하단에는 [1차/2차 분석 실행]과 [임시 저장]만 남았다

#### Verification run

- `.\init.ps1` → 전 항목 `[OK]`, exit 0
- 실기동(http://localhost:8940) — 로그인 → 사례 생성 → `career-step1.html`:
  `#sampleBtn` 이 `scrollY=0` 상태에서 `getBoundingClientRect().top=374px` 로
  뷰포트 안에 있음을 확인. 클릭 → 12항목 채움 + "예시로 채웠습니다" 토스트 확인
- `career-step2.html` 도 동일 확인 — `top=350px`, 클릭 시 경험·학교자료 라디오가
  '있음'으로 켜지고 값이 채워짐, 스크린샷으로 위치 확인

#### 상태

기존 `career-002`·`career-005` (passing)에 이번 확인을 evidence 로 추가했다.
새 기능이 아니라 기존 기능의 UI 배치 수정이라 상태 변경은 없다.

#### Next best step

특별히 없음. 다음 세션은 이 저장소의 남은 미착수(`auth-006`·`auth-007`, 보류)
또는 사용자 지시를 따른다.


### Session 008 — '예시 채우기' 클릭해도 무반응 (진짜 원인) · '예시 지우기' 추가

Session 007 에서 버튼 위치만 옮기고 끝났는데, 사용자가 "눌러도 변화 없음" 이라고
재보고했다. 위치 문제가 아니라 **동작 자체가 안 되는** 더 근본적인 결함이었다.

#### 원인 — `confirm()` 이 브라우저에 의해 조용히 억제될 수 있다

`sampleBtn` 클릭 핸들러 맨 앞에 `if (!confirm('...')) return;` 이 있었다.
Chrome 은 같은 페이지에서 `confirm()`/`alert()` 이 짧은 시간에 여러 번 뜨면
**"이 페이지가 추가 대화상자를 만들지 못하게 함"** 체크박스를 보여주고,
한 번 체크되면 그 뒤로는 **다이얼로그 자체가 뜨지 않고 `confirm()` 이 즉시 `false`
를 반환**한다. 사용자 눈에는 버튼을 눌러도 아무 일도 안 일어나는 것으로만 보인다 —
에러도, 다이얼로그도 없다.

**브라우저 자동화로 재현했다**: 빈 사례를 만들고 `sampleBtn` 을 (JS 오버라이드 없이)
실제로 클릭 → 필드가 그대로 비어 있음을 확인. `window.confirm = () => true` 로
덮어쓴 뒤 클릭하면 정상 채워짐 — 핸들러 로직 자체는 멀쩡했고, 게이트 역할을 하는
`confirm()` 호출 지점이 문제였다.

#### 고친 것

- `career-step1.html` · `career-step2.html`: `sampleBtn` 핸들러에서 `confirm()` 제거.
  로컬 테스트 데이터를 덮어쓰는 가역적인 동작이라 확인창이 굳이 필요 없다고 판단했다
- **`clearBtn`("예시 지우기") 신설** — `sampleBtn` 이 채우는 항목만 정확히 되돌린다.
  1차: 12항목 전부 공백 + `syncByGrade(false)` 로 성적/진학연도 선택지도 초기 상태로.
  2차: 경험·학교자료 라디오를 '없음'으로 되돌리고 17항목+교사확인사항 공백.
  **`report1`(1차 결과)은 건드리지 않는다** — 그건 예시가 아니라 실제 저장된 데이터다
- 두 버튼을 `steps` 인디케이터 바로 아래(Session 007 에서 옮긴 자리)에 나란히 배치

#### Verification run

- `.\init.ps1` → 전 항목 `[OK]`, exit 0
- 실기동(localhost:8940), **전부 실제 클릭 · JS 오버라이드 없음**:
  - 1차: 빈 사례 → 클릭 → 12항목 채움(고등학교 2학년 / 반도체를 하고 싶다 / … / 수도권
    4년제) 확인. [예시 지우기] 클릭 → 전부 공백 + "선택하세요" 로 복귀, 힌트 문구도
    초기 상태로 확인
  - 2차: 클릭 → 라디오 '있음' 전환 + 17항목+교사질문 채움 확인. [예시 지우기] 클릭 →
    라디오 '없음' 복귀 + 전부 공백, `report1` 은 손대지 않음 확인

#### 상태

`career-002`·`career-005`(둘 다 passing)에 이번 결함·수정 evidence 추가.
새 기능이 아니라 기존 기능의 결함 수정이라 상태 변경은 없음.

#### Next best step

특별히 없음. `deleteCase`(사례 삭제) 등 다른 곳에도 같은 `confirm()` 패턴이 있는지는
확인하지 않았다 — 이번 세션 범위 밖. 필요하면 다음에 훑어볼 것.
