# Session Handoff

> 최종 갱신: 2026-09-01 (Session 003)
> 상세 이력은 `claude-progress.md`, 기능 상태는 `feature_list.json` 참고.

## Verified Now

- **동작하는 것 ① 로그인 데모** (Session 002에서 검증, 이번 세션에서 회귀 없음)
  - `index.html` → `login.html` → 성공 `home.html` / 실패 `error.html`, `signup.html` 가입
- **동작하는 것 ② 진로상담 분석** (이번 세션 신규)
  - `home.html` 진입 카드 → `career.html`(사례 목록) → `career-step1`(학생 정보 12항목)
    → `career-report1`(1차 분석·md 저장) → `career-step2`(추가정보) → `career-report2`(2차 분석)
  - 결과는 `localStorage`(`np_career_cases`)에 보존되고 md 파일로 저장된다
  - 보고서는 자체 마크다운 렌더러로 표·제목·인용·코드블록까지 그린다
- **실제로 돌린 검증**
  1. `.\init.ps1` → **53개 항목 전부 `[OK]`, exit 0**
  2. 브라우저 실기동(http://localhost:8940) 전 경로 통과, 콘솔 오류 0건
  3. 실패 경로도 확인 — 잘못된 프록시 주소 → “프록시에 연결하지 못했습니다…” 화면
  4. 옵시디언 전송 클릭 → “추후 결정” 안내로 차단됨

## Changed This Session

- **신규 화면 5종**: `career.html` · `career-step1.html` · `career-report1.html` ·
  `career-step2.html` · `career-report2.html`
- **신규 자산**: `assets/career.css` · `assets/career.js` · `assets/career-prompts.js`(생성물) ·
  `assets/prompts/*.txt`(원문 4종) · `tools/build-prompts.py`
- **수정**: `home.html`(진입 카드) · `assets/auth.css`(`.app-card`) · `init.ps1`(26→53 항목) ·
  `feature_list.json`(`career-001`~`009` 주입, 기존 항목 우선순위 뒤로) · `README.md`
- **AI 호출은 프록시 경유 방식으로 구현** — 프롬프트를 복사해 붙여넣는 방식이 아니다
- **옵시디언은 표시만** — 실제 PUT 코드는 `sendToObsidian()` 안 TODO 블록에 준비돼 있다

## Broken Or Unverified

- **알려진 결함**: 없음(현재 범위 기준)
- **미결(사용자 결정 대기)**
  - ⚠ **`career-008` — AI 프록시 주소·API 키.** 지금 나오는 결과는 **전부 모의 응답**이다.
    상담 자료로 쓰면 안 된다. 화면·md 양쪽에 모의 경고가 붙는다
  - ⚠ **`career-009` — 옵시디언 Local REST API 접속정보.** 주소·API 키·볼트 폴더 미정
- **미검증 경로**
  - **실제 AI 응답으로는 한 번도 돌려보지 못했다.** 프록시가 붙으면
    ① 긴 응답의 md 렌더 ② `max_tokens` 부족으로 잘리는 경우 ③ 응답 지연 시 UX 를 다시 봐야 한다
  - 모바일 실제 단말 표시 (반응형 CSS 는 넣었으나 실기기 확인 안 함)
- **다음 세션 리스크**
  - ⚠ **`init.ps1` 은 UTF-8 BOM 필수.** 이번 세션 편집 후에도 BOM 유지를 확인했다
  - ⚠ **`assets/career-prompts.js` 는 생성물이다.** `assets/prompts/*.txt` 를 고쳤으면
    `python tools/build-prompts.py` 를 다시 돌릴 것 — `init.ps1` 이 수정시각을 비교해 잡는다
  - ⚠ **careerTest 의 `career_proxy.gs` 에 Anthropic API 키가 평문으로 있다.**
    프록시를 만들 때 참고는 하되 **키를 이 저장소로 옮기지 말 것**
  - ⚠ 프롬프트가 요구하는 **공식자료 웹검색**은 프록시 쪽 몫이다.
    검색 없이 호출하면 “확인 불가”가 대량으로 나온다
  - 브라우저 패널의 스크롤 스크린샷이 긴 문서에서 빈 화면으로 찍힌다 —
    **앱 문제가 아니라 캡처 도구 한계**(순수 텍스트 파일에서도 동일). DOM 판독으로 검증할 것
  - `AGENTS.md` 와 `CLAUDE.md` 내용이 거의 동일 — 규칙 변경 시 양쪽 동시 갱신

## Next Best Step

- **최우선 미완 기능**: `career-008` — AI 프록시 주소·API 키 확정
- **왜 이것이 다음인가**: 화면·저장·문서화는 전부 끝났고, 값 하나만 들어오면 실제로 동작한다.
  지금은 모의 응답이라 실사용이 불가능하다
- **무엇이 통과 기준인가**: 연결 설정에 프록시 URL 을 넣으면 배지가 “AI 연결됨”으로 바뀌고,
  1·2차 분석이 실제 응답을 받아 오며 모의 경고 배너가 뜨지 않을 것
- **프록시 계약 (이미 확정, 구현만 하면 됨)**
  ```
  POST <프록시 URL>
  Content-Type: text/plain;charset=utf-8
  { "system": "...", "prompt": "...", "max_tokens": 8000, "model": "claude-sonnet-5" }
  → 200 { "text": "...", "usage": {...}, "error": null }
  ```
- **그 단계에서 바꾸면 안 되는 것**
  - `init.ps1` 의 검증 게이트를 느슨하게 만들지 말 것 — 프록시가 붙으면 검증을 **추가**하는 방향
  - 모의 응답 경로를 지우지 말 것 — 프록시 장애 시 흐름 검증 수단이 사라진다
  - 모의 응답에 사실 정보를 지어 넣지 말 것 — 지금은 의도적으로 “확인 불가”만 채운다
  - `assets/prompts/*.txt` 원문을 코드에서 직접 고치지 말 것 (생성기 경유)

## Commands

- **Startup(검증만)**: `.\init.ps1`
- **Startup(서버까지)**: `.\init.ps1 -Start`  /  브라우저까지: `.\init.ps1 -Start -OpenBrowser`
- **Verification**: `init.ps1` 에 포함 (별도 테스트 러너 없음)
- **프롬프트 재생성**: `python tools/build-prompts.py`
- **Focused debug**
  - 서버만 단독 기동: `python -m http.server 8940`
  - 진로상담 바로 열기: http://localhost:8940/career.html (로그인 필요)
  - 계정 초기화: `localStorage.removeItem('np_users')`
  - 상담 사례 초기화: `localStorage.removeItem('np_career_cases')`
  - 연결 설정 초기화: `localStorage.removeItem('np_career_config')`
  - 세션만 해제: `localStorage.removeItem('np_session'); sessionStorage.removeItem('np_session')`
