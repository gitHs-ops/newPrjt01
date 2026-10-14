# Railway MySQL 웹 데모 배포

GitHub 저장소 `gitHs-ops/newPrjt01` → Root Directory `/seikyu-preview` → Dockerfile로 배포.
Java 본 개발과 분리된 임시 Node API이며, 계산 규칙은 기존 웹 데모의 domain.mjs를 서버에서 실행한다.

## Railway 설정

1. 대상 프로젝트의 MySQL과 같은 환경에 GitHub 앱 서비스를 추가한다.
2. 앱 서비스 Root Directory를 `/seikyu-preview`로 지정한다. Dockerfile을 사용한다.
3. 앱 서비스 Variables에 아래 참조를 등록한다. 실제 DB 서비스 이름이 다르면 `MySQL`을 바꾼다.

```dotenv
MYSQLHOST=${{MySQL.MYSQLHOST}}
MYSQLPORT=${{MySQL.MYSQLPORT}}
MYSQLDATABASE=${{MySQL.MYSQLDATABASE}}
MYSQLUSER=${{MySQL.MYSQLUSER}}
MYSQLPASSWORD=${{MySQL.MYSQLPASSWORD}}
DEMO_USER=reviewer
DEMO_PASSWORD=<직접 지정하는 16자 이상의 비밀번호>
```

4. Healthcheck Path `/health`, 앱 Generate Domain을 설정한다. 앱은 Railway PORT로 수신한다.
5. HTTPS 주소에서 브라우저의 인증창에 DEMO_USER/DEMO_PASSWORD를 입력한다.
6. 화면 상단 `MySQL サーバーに保存`을 확인하고 다른 브라우저에서도 입력 결과를 확인한다.

DB 비밀번호를 클라이언트 파일이나 Git에 넣지 않는다. 같은 환경의 내부 호스트로 연결한다. 별도 TLS CA가 제공되는 연결에는 MYSQL_SSL_CA 환경변수를 사용할 수 있다.

## 저장과 호환 범위

- 거래 상태는 `preview_workspace`, 감사 이력은 `preview_audit`에 저장한다. 마스터는 개별 테이블에서 읽고 쓰며 `preview_master_link`는 기존 ID와 일부 보조 속성을 보존한다. 상세는 MASTER_STORAGE.md 참조.
- 44개 설계 테이블 중 마스터 관련 테이블을 연결한 1단계다. 거래 테이블 연결은 아직 진행하지 않았다.
- 최초 실행 시 존재하지 않는 데모 행만 샘플로 생성한다. 앱 재시작·배포 시 기존 행을 덮어쓰지 않는다.
- 트랜잭션·행 잠금·revision 확인으로 동시 수정 덮어쓰기를 방지한다. 연결/저장 실패 시 브라우저 저장으로 우회하지 않는다.
- 기본 인증을 공유하는 검토용 작업공간이다. 개인별 계정·역할·본인 구분은 본 개발 범위다.
- 마스터 개별 테이블 전환 이후 서버의 전체 초기화를 차단했다.
- 기존 localStorage 데이터는 보존되지만 자동 이관하지 않는다. 실제 자료를 데모로 이관하지 않는다.
- GitHub Pages의 `/seikyu-preview/` 주소는 서버를 실행할 수 없어 local 모드를 유지한다. Railway 배포 확인 후 이용 주소는 Railway HTTPS 주소로 안내한다.

## 검증

`npm test`는 도메인·HTTP 인증·CSRF·오류 처리를 검사한다. HTTP 테스트의 저장소는 테스트 대역이다.
빈 테스트 MySQL에만 MYSQL_TEST_URL을 설정하면 동일 명령에서 실제 MySQL 지속성·경합·롤백 테스트가 실행된다. 검토 데이터가 생성되므로 운영 DB에서 실행하지 않는다.

2026-10-14 실제 Railway 배포와 MySQL 마스터 저장 검증 완료. 배포 주소: https://newprjt01-production.up.railway.app
