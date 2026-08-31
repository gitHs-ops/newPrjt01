# Session Handoff

> 최종 갱신: 2026-08-31 (Session 002)
> 상세 이력은 `claude-progress.md`, 기능 상태는 `feature_list.json` 참고.

## Verified Now

- **동작하는 것**: 로그인 데모 전체 흐름
  - `index.html` 랜딩 → `login.html` → 성공 `home.html` / 실패 `error.html`, `signup.html` 가입
  - 회원가입: 아이디 중복확인, 비밀번호 재확인, 보기/숨김 토글
  - 로그인: 상태 유지 체크박스, 비밀번호 찾기 모달, Google 모의 로그인, Enter 키 제출
- **실제로 돌린 검증**
  1. `.\init.ps1` → **26개 항목 전부 `[OK]`, exit 0**
  2. 브라우저 실기동(http://localhost:8940) 전 경로 통과 —
     가입→로그인→홈, 오답 로그인→`error.html`, 상태유지 on/off 저장위치 전환,
     Google 모의 로그인, 중복가입 차단, 세션 없이 `home.html` 접근 시 차단
  3. **저장값 확인: 평문 비밀번호가 저장소에 없음**(salt + 44자 해시만 존재)

## Changed This Session

- **코드/동작 추가**
  - 신규: `login.html` · `signup.html` · `home.html` · `error.html`
  - 신규 공통 자산: `assets/auth.css`(글래스모피즘 디자인 시스템) · `assets/auth.js`(인증 로직)
  - `index.html` 에 로그인 데모 진입 버튼 추가
- **하네스 변경**
  - **`init.sh` → `init.ps1` 변환**(요청 사항). 검증 항목 7개 → **26개**로 확장해
    새로 만든 로그인 기능을 반영: 앱 파일 존재, HTML 무결성, 공통자산 참조 누락 탐지,
    `auth.js` 공개 API 8종, **PBKDF2 해싱 경로 존재**, JSON 파싱, python, 포트 상태
  - `AGENTS.md`·`CLAUDE.md` 의 `./init.sh` → `.\init.ps1` 갱신
  - `init.sh` 제거 — 시작 경로를 하나로 유지(둘을 병행하면 갈라진다)
  - `feature_list.json` 재작성: `spec-001` **blocked → passing**, `auth-001`~`auth-005` 추가,
    미착수 `auth-006`(서버 인증)·`auth-007`(실제 OAuth) 명시

## Broken Or Unverified

- **알려진 결함**: 없음(현재 범위 기준)
- **미검증 경로**
  - 모바일 실제 단말에서의 표시 — 반응형 CSS 는 넣었으나 실기기 확인은 안 했다
  - 브라우저를 완전히 종료했다가 재실행했을 때의 상태유지 — 코드상 `localStorage` 이므로
    유지되어야 하지만, 실제 재시작 검증은 하지 않았다
- **다음 세션 리스크**
  - ⚠ **`init.ps1` 은 UTF-8 BOM 필수.** BOM 이 빠지면 PowerShell 5.1 이 cp949 로 읽어
    한글이 깨지고 파서 오류가 난다(이번 세션에서 실제로 겪음). 편집 도구가 BOM 을
    떨어뜨리지 않는지 확인할 것
  - ⚠ **인증이 전부 클라이언트 측**이다. `home.html` 의 가드는 보안 경계가 아니며,
    계정은 브라우저별로 격리된다 → `auth-006`
  - ⚠ **Google 버튼은 실제 OAuth 가 아니다** → `auth-007`
  - `AGENTS.md` 와 `CLAUDE.md` 내용이 거의 동일 — 규칙 변경 시 양쪽 동시 갱신

## Next Best Step

- **최우선 미완 기능**: `auth-006` — 서버 기반 인증으로 전환
- **왜 이것이 다음인가**: 지금 데모의 한계가 전부 여기서 나온다 —
  브라우저별 계정 격리, 클라이언트 가드의 무의미함, 실제 OAuth 불가(`auth-007` 의 선행 조건)
- **무엇이 통과 기준인가**: 다른 브라우저에서 같은 계정으로 로그인되고,
  클라이언트 저장소를 지워도 계정이 남아 있을 것
- **그 단계에서 바꾸면 안 되는 것**
  - `init.ps1` 의 검증 게이트를 느슨하게 만들지 말 것 — 서버가 붙으면 검증을 **추가**하는 방향
  - 비밀번호 해싱을 걷어내고 평문으로 되돌리지 말 것(서버로 옮겨도 해싱은 유지)
- **데모로 충분하다면**: 현 상태에서 커밋하고 종료해도 된다. 모든 항목이 검증 완료 상태다

## Commands

- **Startup(검증만)**: `.\init.ps1`
- **Startup(서버까지)**: `.\init.ps1 -Start`  /  브라우저까지: `.\init.ps1 -Start -OpenBrowser`
- **Verification**: `init.ps1` 에 포함 (별도 테스트 러너 없음)
- **Focused debug**
  - 서버만 단독 기동: `python -m http.server 8940`
  - 계정 초기화: 브라우저 개발자도구 콘솔에서 `localStorage.removeItem('np_users')`
  - 세션만 해제: `localStorage.removeItem('np_session'); sessionStorage.removeItem('np_session')`
