# Session Handoff

> 최종 갱신: 2026-09-01 (Session 003 + 웹검색 후속)
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
  1. `.\init.ps1` → **62개 항목 전부 `[OK]`, exit 0**
  2. 브라우저 실기동(http://localhost:8940) 전 경로 통과, 콘솔 오류 0건
  3. 실패 경로도 확인 — 잘못된 프록시 주소 → “프록시에 연결하지 못했습니다…” 화면
  4. 옵시디언 전송 클릭 → “추후 결정” 안내로 차단됨

## Changed This Session

- **신규 화면 5종**: `career.html` · `career-step1.html` · `career-report1.html` ·
  `career-step2.html` · `career-report2.html`
- **신규 자산**: `assets/career.css` · `assets/career.js` · `assets/career-prompts.js`(생성물) ·
  `assets/prompts/*.txt`(원문 4종) · `tools/build-prompts.py`
- **수정**: `home.html`(진입 카드) · `assets/auth.css`(`.app-card`) · `init.ps1`(26→**62 항목**) ·
  `feature_list.json`(`career-001`~`010` 주입, 기존 항목 우선순위 뒤로) · `README.md`
- **AI 호출은 프록시 경유 방식으로 구현** — 프롬프트를 복사해 붙여넣는 방식이 아니다
- **공식자료 웹검색을 붙였다**(`career-010`) — 프록시가 Anthropic 서버사이드 `web_search`
  도구를 켜도록 요청에 지시를 싣고, 결과 화면에 참고한 출처를 나열한다.
  참고 프록시 `tools/career_proxy.example.gs` 신규. 기본 모델 `claude-opus-5`
- **프록시를 careerTest 와 공유 가능하게 GET/POST 겸용으로 만들었다** —
  `doGet`(careerTest, 기존 그대로) + `doPost`(진로상담) 한 파일. 배포 하나, 키 하나
- **실행시간 초과 대응** — 배포 후 `testProxy()` 가 끝나지 않는 문제를 잡았다.
  `effort=low` 기본, `MAX_CONTINUATIONS 4→1`, `DEADLINE_MS`(4분) 시간 가드 추가.
  점검 함수를 `test1_key` → `test2_search` → `test3_load` → `test4_careertest` 로 분리
- **옵시디언은 표시만** — 실제 PUT 코드는 `sendToObsidian()` 안 TODO 블록에 준비돼 있다

## Broken Or Unverified

- **알려진 결함**: 없음(현재 범위 기준)
- **미결(사용자 결정 대기)**
  - ⚠ **`career-008` — AI 프록시 배포·API 키.** 지금 나오는 결과는 **전부 모의 응답**이다.
    상담 자료로 쓰면 안 된다. 화면·md 양쪽에 모의 경고가 붙는다.
    프록시 코드는 `tools/career_proxy.example.gs` 에 다 있고, 남은 건 배포와 키뿐이다
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
  - ⚠ **웹검색은 프록시가 배포되어야 실제로 돈다.** 클라이언트는 지시만 보낸다.
    프록시가 도구를 안 켜면 결과 화면에 **출처 0건 경고**가 뜬다 — 의도된 경고다
  - ⚠ **API 키를 소스에 넣지 말 것.** `init.ps1` 이 저장소에서 `sk-ant-` 를 찾으면 검증 실패한다.
    키는 Apps Script 스크립트 속성에만 둔다
  - 브라우저 패널의 스크롤 스크린샷이 긴 문서에서 빈 화면으로 찍힌다 —
    **앱 문제가 아니라 캡처 도구 한계**(순수 텍스트 파일에서도 동일). DOM 판독으로 검증할 것
  - `AGENTS.md` 와 `CLAUDE.md` 내용이 거의 동일 — 규칙 변경 시 양쪽 동시 갱신

## Next Best Step

- **최우선 미완 기능**: `career-008` — AI 프록시 주소·API 키 확정
- **왜 이것이 다음인가**: 화면·저장·문서화는 전부 끝났고, 값 하나만 들어오면 실제로 동작한다.
  지금은 모의 응답이라 실사용이 불가능하다
- **무엇이 통과 기준인가**: 연결 설정에 프록시 URL 을 넣으면 배지가 “AI 연결됨”으로 바뀌고,
  1·2차 분석이 실제 응답을 받아 오며 모의 경고 배너가 뜨지 않을 것
- **프록시는 이미 다 짜여 있다** — `tools/career_proxy.example.gs` 를 Apps Script 에 붙여넣고
  스크립트 속성 `ANTHROPIC_API_KEY` 만 채운 뒤 `/exec` URL 을 [연결 설정]에 넣으면 끝이다.
  ```
  POST <프록시 URL>
  Content-Type: text/plain;charset=utf-8
  { "system": "...", "prompt": "...", "max_tokens": 8000, "model": "claude-opus-5",
    "web_search": true, "search_max_uses": 12, "allowed_domains": [...] }
  → 200 { "text": "...", "usage": {...}, "sources": [{title,url}], "searches": 3,
          "truncated": false, "error": null }
  ```
- **careerTest 배포에 얹는 경우** — 반드시 **배포 관리 → 편집 → 새 버전**으로 갱신할 것.
  “새 배포”를 만들면 `/exec` URL 이 바뀌어 careerTest 가 끊긴다.
  기존 소스에 박힌 API 키는 지우고 스크립트 속성으로 옮긴다
- **배포 직후 점검 순서** — Apps Script 편집기에서 **순서대로** 실행할 것.
  “끝나지 않음”은 대부분 고장이 아니라 요청이 무거워 6분 한도에 걸린 것이다.
  | 함수 | 확인하는 것 | 기대 |
  |---|---|---|
  | `test1_key` | 키·네트워크 (검색 없음) | 수 초 안에 HTTP 200 |
  | `test2_search` | 검색 1회 소요 시간 | `elapsed=` 값을 기록해 둘 것 |
  | `test3_load` | 검색 4회 부하 | `test2 시간 × 4` 가 4분을 넘으면 검색 횟수를 낮춘다 |
  | `test4_careertest` | 기존 GET 경로 회귀 | careerTest 가 계속 도는지 |
- **그다음 확인**
  ① 응답이 잘리는지(잘림 경고) → `max_tokens` 조정
  ② “참고한 웹 출처” 카드에 공식 기관이 실제로 잡히는지
  ③ `incomplete` 경고가 뜨면 검색 횟수·effort 를 낮출 것
- **그래도 6분을 못 맞추면** — Apps Script 자체가 한계다.
  effort/검색횟수를 더 낮추거나, 실행 한도가 없는 런타임(Cloudflare Workers 등)으로
  프록시를 옮기는 것이 근본 해법이다. 계약(POST/JSON)은 그대로 쓸 수 있다
- **그 단계에서 바꾸면 안 되는 것**
  - `init.ps1` 의 검증 게이트를 느슨하게 만들지 말 것 — 프록시가 붙으면 검증을 **추가**하는 방향
  - 모의 응답 경로를 지우지 말 것 — 프록시 장애 시 흐름 검증 수단이 사라진다
  - 모의 응답에 사실 정보를 지어 넣지 말 것 — 지금은 의도적으로 “확인 불가”만 채운다
  - **웹검색 기본값을 끄지 말 것** — 끄면 프롬프트가 금지한 “기억으로 답하기”가 된다
  - **`MAX_CONTINUATIONS` 를 올리지 말 것** — 무거운 호출이 직렬로 반복돼 6분 한도를 넘긴다.
    `init.ps1` 이 0~2 범위를 검사한다(2026-09-01 실제로 매달림)
  - **`DEADLINE_MS` 가드를 지우지 말 것** — 없으면 한도 초과 시 아무것도 못 돌려준다
  - **“공식 기관 도메인만” 을 기본값으로 켜지 말 것** — 대학 입학처가 학교마다 도메인이 달라
    STEP 7-3(대학 정보·입시결과)이 통째로 막힌다
  - `assets/prompts/*.txt` 원문을 코드에서 직접 고치지 말 것 (생성기 경유)
  - **프록시 예시의 `doGet` 을 지우지 말 것** — careerTest 가 그 경로를 쓴다.
    `init.ps1` 이 `doGet` / `CAREERTEST_SYSTEM` 존재를 검사한다

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
  - 연결 설정(프록시·웹검색) 초기화: `localStorage.removeItem('np_career_config')`
  - 세션만 해제: `localStorage.removeItem('np_session'); sessionStorage.removeItem('np_session')`
