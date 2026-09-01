# newPrjt01

빌드 단계가 없는 **정적 HTML 앱** 두 벌.

1. **로그인 데모** — 계정은 브라우저 `localStorage` 에만 저장하는 테스트용이며,
   비밀번호는 평문이 아니라 **PBKDF2-SHA256(10만회) + 사용자별 랜덤 솔트** 해시로 보관한다.
2. **진로상담 분석** — 중·고 진로교사용. 학생 정보로 **1차 진로·산업·진학 리서치**를 수행하고,
   추가 경험·학교자료를 더해 **2차 진로 가설 분석**까지 이어간다. 결과는 브라우저에 보존되고
   **md 파일**로 저장할 수 있다. 로그인 성공 화면(`home.html`)에서 진입한다.

## 실행

```powershell
.\init.ps1 -Start
```

→ http://localhost:8940/

| 옵션 | 동작 |
|---|---|
| `.\init.ps1` | 검증만 수행 (63개 항목) |
| `.\init.ps1 -Start` | 검증 후 로컬 서버 기동 |
| `.\init.ps1 -Start -OpenBrowser` | 기동 후 브라우저까지 열기 |
| `-Port 9000` | 포트 변경 (기본 8940) |

> ⚠ `init.ps1` 은 **UTF-8 BOM** 으로 저장해야 한다. BOM 이 없으면 Windows PowerShell 5.1 이
> cp949 로 읽어 한글이 깨지고 파서 오류가 난다.

## 화면

| 파일 | 역할 |
|---|---|
| `index.html` | 랜딩 (로그인 데모 진입) |
| `login.html` | 로그인 — 상태 유지, 비밀번호 찾기(모달), Google 버튼(모의), Enter 키 |
| `signup.html` | 회원가입 — 아이디 중복확인, 비밀번호 재확인, 보기/숨김 토글 |
| `home.html` | 로그인 성공 — 세션 정보 표시, 로그아웃 |
| `error.html` | 로그인 실패 — 사유 표시 |
| `assets/auth.css` | 공통 디자인 시스템 (라이트 글래스모피즘) |
| `assets/auth.js` | 공통 인증 로직 (해싱·세션·검증) |

### 진로상담 (로그인 필요)

| 파일 | 역할 |
|---|---|
| `career.html` | 진로상담 홈 — 새 사례 생성, 저장된 사례 목록, 연결 설정 |
| `career-step1.html` | 1차 입력 — 학생 정보 12항목(필수 3 / 선택 9), 드롭다운·예시 채우기, 전달 내용 미리보기 |
| `career-report1.html` | 1차 분석 실행·결과 — md 저장, 옵시디언 전송(표시만) |
| `career-step2.html` | 2차 추가정보 — 1차 결과 + 경험·학교자료(있음/없음) + 교사 확인사항, 드롭다운·예시 채우기 |
| `career-report2.html` | 2차 분석 결과 — md 저장, 1·2차 합본 저장 |
| `assets/career.css` | 문서형 레이아웃 · 보고서 스타일 (auth.css 확장) |
| `assets/career.js` | 사례 저장소 · AI 호출 · 마크다운 렌더 · md 저장 · 옵시디언 스텁 |
| `assets/career-prompts.js` | **자동 생성물** — 프롬프트 원문을 담은 파일 |
| `assets/prompts/*.txt` | 프롬프트·입력명세 원문 (단일 원본) |
| `tools/build-prompts.py` | `assets/prompts/*.txt` → `assets/career-prompts.js` 재생성 |
| `tools/career_proxy.example.gs` | AI 프록시 참고 구현 — careerTest(GET) + 진로상담(POST) 겸용, 키는 비어 있음 |
| `tools/obsidian-check.html` | 옵시디언 연결 5단계 실측 도구 |

프롬프트 원문을 고쳤다면:

```bash
python tools/build-prompts.py
```

앱 자체에는 빌드 단계가 없다. 이 스크립트는 프롬프트를 고칠 때만 돌린다.

### 입력 보조

반복 입력 부담을 줄이기 위한 장치들이다.

| 장치 | 동작 |
|---|---|
| **빠른 선택 드롭다운** | 고르면 아래 자유입력란에 덧붙는다(중복은 무시). 과목·산업·계기·일하는 방식·전공, 2차의 조별역할·부탁받는 일 |
| **단일 선택 드롭다운** | 성적 수준·희망 대학 수준·희망 지역·진학 연도 |
| **학교급 연동** | 중학교를 고르면 **성취도 A~E**, 고등학교면 **내신 등급**으로 항목이 바뀐다 |
| **진학 연도 자동 계산** | 학년에서 계산해 기본 선택된다 (중2 → 2031, 고3 → 2027) |
| **예시 채우기** | 전 항목을 테스트용 예시로 한 번에 채운다 |

> 학교급 연동과 연도 자동 계산은 편의 기능이 아니다.
> 프롬프트가 *"현재 학년과 대학 진학 예정 연도가 일치하는가"* 를 검증 항목으로 두고 있어,
> 손으로 넣다 어긋나면 분석이 `[확인 필요]` 로 새 버린다.
> 실제로 "중2인데 2등급 / 진학 2028년" 같은 모순이 발생한 적이 있다.

> ⚠ **희망 직업·직무만은 자유입력으로 남겼다.** 프롬프트 STEP 0 이
> "학생이 말한 표현" 자체를 해석 대상으로 삼기 때문에 선택지로 바꾸면 안 된다.

### AI 호출 방식

`careerTest` 와 같은 **프록시 경유** 방식이다. API 키는 브라우저에 두지 않고 프록시에 둔다.

```
POST <프록시 URL>
Content-Type: text/plain;charset=utf-8      ← GAS 웹앱 CORS preflight 회피
{
  "system": "...", "prompt": "...", "max_tokens": 8000, "model": "claude-haiku-4-5",
  "web_search": true, "search_max_uses": 6, "effort": "low",
  "allowed_domains": ["career.go.kr", ...]        // 선택 — 공식자료 제한 옵션
}

200 { "text": "...", "usage": {...}, "sources": [{title,url}], "searches": 3,
      "model": "...", "web_tools": "basic|v2026",
      "truncated": false, "incomplete": false, "elapsed_ms": 41230, "error": null }
```

**프록시 배포와 API 키는 추후 결정 사항**이다(`career-008`). 비어 있으면 화면 흐름 확인용
**모의 응답**으로 동작하며, 화면과 md 파일 모두에 모의라고 표시된다.

참고 구현이 `tools/career_proxy.example.gs` 에 있다. Apps Script 에 붙여넣고
스크립트 속성 `ANTHROPIC_API_KEY` 만 채우면 동작한다.
**키를 소스에 적지 말 것** — `init.ps1` 이 저장소에서 `sk-ant-` 문자열을 찾으면 검증에 실패한다.

#### careerTest 프록시와 배포 공유

같은 Apps Script 배포·같은 API 키를 `careerTest` 와 함께 쓸 수 있다.
참고 구현이 두 경로를 모두 갖고 있다.

| 경로 | 쓰는 앱 | 동작 |
|---|---|---|
| `GET ?prompt=...&max_tokens=...` | careerTest | 기존 `career_proxy.gs` ver4.1 과 동일 — 고정 system, HTML 출력, 검색 없음 |
| `POST {system, prompt, ...}` | newPrjt01 진로상담 | 프롬프트 전문 수신, md 출력, 웹검색 |

**왜 GET 하나로 합칠 수 없나** — careerTest 는 프롬프트를 URL 쿼리에 싣는데,
진로상담 1차 프롬프트는 **26KB**라 URL 인코딩하면 7만 자를 넘긴다. URL 길이 한계로 원천 불가다.
게다가 careerTest 의 system 은 소스에 고정돼 있고 HTML 을 요구한다.
그래서 GET 은 그대로 두고 POST 를 **추가**한다.

기존 프로젝트에 얹을 때:

1. 기존 Apps Script 프로젝트를 이 파일 내용으로 교체
2. 소스에 박힌 API 키를 지우고 **스크립트 속성** `ANTHROPIC_API_KEY` 로 옮긴다
3. 배포 → **배포 관리 → 편집 → 버전: 새 버전** → 배포
   (⚠ "새 배포"를 만들면 `/exec` URL 이 바뀌어 careerTest 가 끊긴다)
4. 같은 `/exec` URL 을 진로상담 [연결 설정]에 입력

> ⚠ 키를 공유하면 두 앱의 사용량·요금·레이트리밋이 한 계정에 합산된다.
> 진로상담 1회 분석은 웹검색까지 돌므로 careerTest 한 탭보다 훨씬 무겁다.

### 공식자료 웹검색

진로상담 프롬프트는 커리어넷·KOSIS·어디가·Q-Net 같은 **공식자료 확인**을 전제로 씌어 있다.
검색 없이 호출하면 "확인 불가"만 잔뜩 나온다. 그래서 프록시가 Anthropic의
**서버사이드 web_search 도구**(`web_search_20260209`, 동적 필터링)를 켠다 —
별도 검색 API는 필요 없다. `web_fetch` 도 함께 켜서 기준연도·시행 여부를 원문에서 확인한다.

| 설정 | 기본값 | 설명 |
|---|---|---|
| 웹검색 사용 | 켬 | 끄면 모델 기억만으로 답한다 — 프롬프트가 금지하는 상태 |
| 분석 1회당 최대 검색 | 6 | `max_uses` 로 전달 |
| 사고 깊이 (effort) | `low` | 실행시간을 좌우한다 — **Haiku 는 미지원** |
| 공식 기관 도메인만 | **끔** | 켜면 `allowed_domains` 16개 기관으로 제한 |

#### 모델 선택

기본은 **Haiku 4.5**(`claude-haiku-4-5`)다. 빠르고 저렴해서 Apps Script 6분 한도 안에 들어오기 쉽다.
설정에서 Sonnet 5 · Opus 5 로 올릴 수 있다.

**모델에 따라 요청 형태가 달라진다.** 프록시가 두 헬퍼로 흡수한다.

| | Haiku 4.5 (기본) | Sonnet 5 / Opus 5 |
|---|---|---|
| 웹검색 도구 | `web_search_20250305` (기본형) | `web_search_20260209` (동적 필터링) |
| `output_config.effort` | **보내면 오류** → 생략 | 적용 |
| 속도·비용 | 빠름 / $1·$5 per MTok | 느림 / Sonnet $2·$10, Opus $5·$25 |

> ⚠ 품질 트레이드오프가 있다. 이 프롬프트는 `[확인]`·`[해석]`·`[제안]` 구분,
> 근거 없는 수치 금지, "확인 불가" 표시 같은 **엄격한 지시 준수**를 요구한다.
> Haiku 로 돌린 뒤 그 규칙이 지켜지는지 실제 출력으로 확인하고, 흐트러지면 Sonnet 5 로 올릴 것.

#### ⚠ 실행시간 — Apps Script 6분 한도

`claude-opus-5`는 **적응형 사고가 기본 ON**이고 effort 기본값이 `high`다.
여기에 웹검색 서버 루프까지 겹치면 한 번 호출이 수 분씩 걸리는데,
Apps Script는 개인 계정 기준 **실행 6분에서 강제 종료**된다 —
클라이언트 입장에서는 **응답 없이 매달린 것처럼** 보인다(2026-09-01 실제 발생).

세 가지로 막았다.

| 장치 | 값 | 역할 |
|---|---|---|
| `DEFAULT_EFFORT` | `low` | 사고 깊이를 낮춰 호출 시간을 줄인다 |
| `MAX_CONTINUATIONS` | `1` | `pause_turn` 이어달리기를 제한 — 무거운 호출의 직렬 반복을 막는다 |
| `DEADLINE_MS` | 4분 | 넘기면 스스로 끊고 **받은 만큼 돌려준다**(`incomplete: true`) |

`incomplete` 가 오면 결과 화면에 “검색을 끝까지 못 돌렸습니다” 경고와 소요 시간이 뜬다.
그때는 검색 횟수나 effort 를 낮추면 된다. 시간이 남으면 반대로 올려서 품질을 높인다.

> ⚠ **"공식 기관 도메인만" 을 켜면 대학 입학처·학과 홈페이지가 막힌다**(학교마다 도메인이 다름).
> 대학 정보·입시결과가 필요한 고3 상담에서는 꺼 둘 것. 그래서 기본값이 꺼짐이다.

결과 화면의 **"참고한 웹 출처"** 카드에 실제로 조회한 페이지가 나열된다.
출처가 하나도 없으면 경고가 뜬다 — 그 보고서는 모델 기억에 의존한 것이므로 신뢰하면 안 된다.

서버 도구 루프는 10회에서 `pause_turn` 으로 끊기므로 프록시가 이어달리기를 한다(최대 4회).

### 옵시디언 전송

**Obsidian Local REST API** 플러그인으로 볼트에 바로 쓴다.
결과 화면의 **[옵시디언으로 전송]** 버튼이 `PUT {baseUrl}/vault/{폴더}/{파일}.md` 를 호출한다.

준비:

1. 옵시디언 → 커뮤니티 플러그인에서 **`Local REST API with MCP`**(저자 Adam Coddington) 설치·활성화
   — 등록 이름이 바뀌었으니 `REST` 로 검색할 것
2. 플러그인 설정에서 **"Enable Non-encrypted (HTTP) Server"** 켜기 (27123)
3. **API 키** 복사
4. 진로상담 → [연결 설정] → 옵시디언 전송에 주소·키·폴더 입력 → **연결 테스트**

> 폴더는 **미리 만들 필요 없다.** 전송 시점에 플러그인이 상위 폴더를 자동 생성한다.
> 파일명에 타임스탬프가 붙어 덮어쓰기 사고도 나지 않는다.

> ⚠ **HTTPS(27124)는 쓰지 말 것.** 자체서명 인증서라 브라우저 `fetch` 가 거부한다.
> 굳이 쓰려면 주소창에 직접 열어 인증서 예외를 등록해야 한다. HTTP 27123 이 마찰이 없다.

> ⚠ **API 키는 `localStorage` 에 평문 저장된다.** 로컬 전용 키이고 이 브라우저에만 남지만
> 공용 PC 에서는 쓰지 말 것.

문제가 생기면 **연결 실측 도구**로 어느 단계가 막혔는지 확인한다:

```bash
start http://localhost:8940/tools/obsidian-check.html
```

도달 → CORS → 인증서 → 인증(preflight) → 쓰기 5단계를 순서대로 판정한다.
`no-cors` 프로브로 **연결 거부와 CORS 차단을 구분**하는 것이 핵심 —
둘 다 `fetch` 에서는 똑같이 `Failed to fetch` 로 보인다.

## 데이터

| 키 | 저장소 | 내용 |
|---|---|---|
| `np_users` | `localStorage` | 계정 목록 — `id`, `salt`, `hash`, `provider`, `createdAt` |
| `np_session` | 상태유지 켬 → `localStorage`<br>끔 → `sessionStorage` | `id`, `provider`, `remember`, `loginAt` |
| `np_career_cases` | `localStorage` | 상담 사례 — `label`, `owner`, `student`, `report1`, `extra2`, `report2` |
| `np_career_config` | `localStorage` | 연결 설정 — 프록시 URL, 모델, max_tokens, 웹검색 옵션, **옵시디언 주소·API 키·폴더** |

초기화: 개발자도구 콘솔에서
`localStorage.removeItem('np_users')` / `localStorage.removeItem('np_career_cases')`

> 사례 이름은 **AI 로 전달되지 않는** 로컬 라벨이다. 학생 실명 대신 별칭을 쓸 것.
> 학교자료 입력란에 개인식별정보·민감정보를 넣지 말 것.

## 한계 (실서비스로 쓰기 전에 반드시 해결)

- **인증이 전부 클라이언트 측이다.** `home.html` 의 접근 제어는 가드일 뿐 보안 경계가 아니다
- **계정이 브라우저별로 격리된다.** 다른 기기·브라우저·시크릿창에서는 보이지 않는다
- **Google 로그인은 실제 OAuth 가 아니다.** 흐름만 재현한 모의 동작이다
- `file://` 로 직접 열면 동작하지 않는다 — Web Crypto 가 보안 컨텍스트를 요구하므로
  반드시 로컬 서버로 띄워야 한다

진로상담 쪽 한계:

- **AI 프록시가 배포되지 않았다.** 지금은 모의 응답으로만 흐름이 돌아간다 (`career-008`)
- ~~옵시디언 전송~~ — **동작 확인됨**(2026-09-01). 플러그인 설치 + [연결 설정]만 하면 된다
- **사례가 브라우저별로 격리된다.** 로그인 데모와 같은 한계다
- **웹검색은 프록시가 배포되어야 실제로 돈다.** 클라이언트는 지시를 보내지만
  프록시가 `web_search` 도구를 켜지 않으면 “확인 불가”가 대량으로 나온다 —
  결과 화면이 **출처 0건 경고**로 알려준다

→ 남은 과제는 `feature_list.json` 의 `career-008`(AI 프록시 배포),
그리고 보류된 `auth-006`(서버 인증) · `auth-007`(실제 OAuth) 참고.

## 에이전트 하네스

이 저장소는 장시간 에이전트 작업을 전제로 구성돼 있다.

| 파일 | 역할 |
|---|---|
| `AGENTS.md` / `CLAUDE.md` | 에이전트 운영 지침 |
| `init.ps1` | 표준 시작·검증 경로 |
| `feature_list.json` | 기능 상태의 단일 원본 |
| `claude-progress.md` | 세션 진행 로그 |
| `session-handoff.md` | 세션 간 인계 노트 |

세션을 시작할 때는 `claude-progress.md` → `feature_list.json` 순으로 읽고 `.\init.ps1` 을 실행한다.

템플릿 출처: [walkinglabs/learn-harness-engineering](https://github.com/walkinglabs/learn-harness-engineering) (MIT)
