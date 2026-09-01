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
| `.\init.ps1` | 검증만 수행 (53개 항목) |
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
| `career-step1.html` | 1차 입력 — 학생 정보 12항목(필수 3 / 선택 9), 전달 내용 미리보기 |
| `career-report1.html` | 1차 분석 실행·결과 — md 저장, 옵시디언 전송(표시만) |
| `career-step2.html` | 2차 추가정보 — 1차 결과 + 경험·학교자료(있음/없음) + 교사 확인사항 |
| `career-report2.html` | 2차 분석 결과 — md 저장, 1·2차 합본 저장 |
| `assets/career.css` | 문서형 레이아웃 · 보고서 스타일 (auth.css 확장) |
| `assets/career.js` | 사례 저장소 · AI 호출 · 마크다운 렌더 · md 저장 · 옵시디언 스텁 |
| `assets/career-prompts.js` | **자동 생성물** — 프롬프트 원문을 담은 파일 |
| `assets/prompts/*.txt` | 프롬프트·입력명세 원문 (단일 원본) |
| `tools/build-prompts.py` | `assets/prompts/*.txt` → `assets/career-prompts.js` 재생성 |

프롬프트 원문을 고쳤다면:

```bash
python tools/build-prompts.py
```

앱 자체에는 빌드 단계가 없다. 이 스크립트는 프롬프트를 고칠 때만 돌린다.

### AI 호출 방식

`careerTest` 와 같은 **프록시 경유** 방식이다. API 키는 브라우저에 두지 않고 프록시에 둔다.

```
POST <프록시 URL>
Content-Type: text/plain;charset=utf-8      ← GAS 웹앱 CORS preflight 회피
{ "system": "...", "prompt": "...", "max_tokens": 8000, "model": "claude-sonnet-5" }

200 { "text": "...", "usage": {...}, "error": null }
```

**프록시 주소와 API 키는 추후 결정 사항**이다(`career-008`). 비어 있으면 화면 흐름 확인용
**모의 응답**으로 동작하며, 화면과 md 파일 모두에 모의라고 표시된다.

### 옵시디언 전송

**Obsidian Local REST API 직접 호출**로 방침이 정해졌으나 접속 주소·API 키·볼트 폴더 규칙이
미정이라 **버튼만 표시**되고 전송은 막혀 있다(`career-009`).
확정되면 `assets/career.js` 의 `sendToObsidian()` 안 TODO 블록만 열면 된다.

## 데이터

| 키 | 저장소 | 내용 |
|---|---|---|
| `np_users` | `localStorage` | 계정 목록 — `id`, `salt`, `hash`, `provider`, `createdAt` |
| `np_session` | 상태유지 켬 → `localStorage`<br>끔 → `sessionStorage` | `id`, `provider`, `remember`, `loginAt` |
| `np_career_cases` | `localStorage` | 상담 사례 — `label`, `owner`, `student`, `report1`, `extra2`, `report2` |
| `np_career_config` | `localStorage` | 연결 설정 — 프록시 URL, 모델, max_tokens, 옵시디언 설정 |

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

- **AI 프록시가 연결되지 않았다.** 지금은 모의 응답으로만 흐름이 돌아간다 (`career-008`)
- **옵시디언 전송이 연결되지 않았다.** 버튼만 있고 눌러도 안내만 나온다 (`career-009`)
- **사례가 브라우저별로 격리된다.** 로그인 데모와 같은 한계다
- 프롬프트가 요구하는 **공식자료 웹검색**은 프록시 쪽 구현에 달려 있다.
  검색 없이 호출하면 “확인 불가” 항목이 많아진다

→ 남은 과제는 `feature_list.json` 의 `career-008`·`career-009`,
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
