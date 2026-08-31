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
  - ⚠ **`init.ps1` 은 반드시 UTF-8 BOM 으로 저장할 것.** Windows PowerShell 5.1 은 BOM 없는
    `.ps1` 을 cp949 로 읽어 한글 문자열이 깨지고 파서 오류가 난다(2026-08-31 실제 발생)
- **Standard verification path**: `init.ps1` 에 포함 — 하네스 5파일 + 앱 7파일 존재,
  HTML 무결성 5건, 공통자산 참조 4건, `auth.js` 공개 API 8종, PBKDF2 존재,
  `feature_list.json` 파싱, `python` 가용성, 포트 상태. **26개 항목 전부 통과해야 exit 0**
- **Standard start command**: `python -m http.server 8940` → http://localhost:8940/
  (`.claude/launch.json` 의 `newPrjt01-static` 과 동일 포트)
- **Current highest-priority unfinished feature**: `auth-006` — 서버 기반 인증으로 전환
- **Current blocker**: 없음

## 이 저장소의 성격

- **정적 HTML 로그인 데모.** 빌드 단계 없음, `package.json` 없음, npm 사용 안 함
- 화면: `index.html`(랜딩) · `login.html` · `signup.html` · `home.html`(성공) · `error.html`(실패)
- 공통 자산: `assets/auth.css`(디자인 시스템) · `assets/auth.js`(인증 로직)
- 계정 저장소는 **localStorage**(`np_users`) — 테스트 목적으로 사용자가 명시 허가.
  다만 **비밀번호는 평문이 아니라 PBKDF2-SHA256(10만회) + 사용자별 랜덤 솔트 해시**로 보관
- 세션: 상태유지 켬 → `localStorage`, 끔 → `sessionStorage` (키 `np_session`)
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
- **Commits**: (아직 커밋하지 않음 — 사용자 확인 대기)
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

- Date:
- Goal:
- Completed:
- Verification run:
- Evidence captured:
- Commits:
- Files or artifacts updated:
- Known risk or unresolved issue:
- Next best step:
