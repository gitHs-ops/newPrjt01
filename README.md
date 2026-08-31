# newPrjt01

빌드 단계가 없는 **정적 HTML 로그인 데모**.
계정은 브라우저 `localStorage` 에만 저장하는 테스트용이며, 비밀번호는 평문이 아니라
**PBKDF2-SHA256(10만회) + 사용자별 랜덤 솔트** 해시로 보관한다.

## 실행

```powershell
.\init.ps1 -Start
```

→ http://localhost:8940/

| 옵션 | 동작 |
|---|---|
| `.\init.ps1` | 검증만 수행 (26개 항목) |
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

## 데이터

| 키 | 저장소 | 내용 |
|---|---|---|
| `np_users` | `localStorage` | 계정 목록 — `id`, `salt`, `hash`, `provider`, `createdAt` |
| `np_session` | 상태유지 켬 → `localStorage`<br>끔 → `sessionStorage` | `id`, `provider`, `remember`, `loginAt` |

초기화: 개발자도구 콘솔에서 `localStorage.removeItem('np_users')`

## 한계 (실서비스로 쓰기 전에 반드시 해결)

- **인증이 전부 클라이언트 측이다.** `home.html` 의 접근 제어는 가드일 뿐 보안 경계가 아니다
- **계정이 브라우저별로 격리된다.** 다른 기기·브라우저·시크릿창에서는 보이지 않는다
- **Google 로그인은 실제 OAuth 가 아니다.** 흐름만 재현한 모의 동작이다
- `file://` 로 직접 열면 동작하지 않는다 — Web Crypto 가 보안 컨텍스트를 요구하므로
  반드시 로컬 서버로 띄워야 한다

→ 남은 과제는 `feature_list.json` 의 `auth-006`(서버 인증) · `auth-007`(실제 OAuth) 참고.

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
