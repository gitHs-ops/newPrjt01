# APLink 웹 화면 데모

배포 URL: https://giths-ops.github.io/newPrjt01/seikyu-preview/

추가 자료가 확보될 때까지 업무 화면과 흐름을 확인하는 정적 웹페이지다. Java 소스와 배포 패키지는 `../seikyu/`에 별도로 유지한다. 이번 데모는 Java 서버나 楽々FrameworkⅡ 없이 실행된다.

## 사용 범위

- 6개월 가상 거래, 대시보드, 출하, 청구 작성·발행·인쇄, 입금·부분 소거
- 구매, 실재고, 정시 청구, 소액 현금, 은행 지급, 자동 분개
- 마스터 등록·변경·비활성화·CSV 가져오기, CSV 내보내기, 작업 이력
- 입력은 현재 브라우저의 localStorage에 저장. 새로고침 후 유지되며 다른 기기와 공유하지 않는다.
- 우측 상단 `データ初期化`로 초기 샘플 복원. 브라우저 저장소를 지우면 입력 자료도 사라진다.

## 임시 가정

일본어 화면·엔화, 고객별 마감일, 세율별 합계에서 세액 소수점 절사. 샘플은 10일/20일 마감과 10% 세율을 사용한다. 입금액과 수수료 등의 합계가 소거액과 일치해야 하며 과다 입금을 차단한다. 영수증·전표는 검토용 간이 양식이다.

실제 AS400 업무와 동등하다고 검증한 시스템이 아니다. 가상 데이터만 입력한다. 선급금, 협력회비, 음수 매출의 청구, 현금·카드 매출의 청구, 지급 수수료/상계, JV 배분, 회계·은행 파일 연계는 확정 자료를 기다린다. CSV는 검토용이며 회계 시스템 수입 형식이 아니다. 실제 로그인·권한·서버 저장은 제공하지 않는다.

## 검증

`node --test seikyu-preview/domain.test.mjs`

정적 서버에서 `browser-qa.cjs` 실행. Playwright와 Microsoft Edge 필요. `PLAYWRIGHT_MODULE`로 모듈 경로, `PREVIEW_URL`로 테스트 주소를 지정할 수 있다. 별도 브라우저 프로필의 가상 데이터만 조작한다. 결과는 `validation.json` 참조.

## Railway MySQL 모드

서버 저장 API와 Dockerfile을 추가했다. 배포 절차는 [RAILWAY_DEPLOY.md](RAILWAY_DEPLOY.md) 참조. Railway 배포와 마스터 개별 테이블 연결 검증을 완료했다. [Railway 앱](https://newprjt01-production.up.railway.app)은 개별 마스터 테이블을 사용한다. GitHub Pages는 기존 local 모드다. 기존 브라우저 자료는 자동 이관하지 않는다.

마스터별 저장 위치와 전환 제한: [MASTER_STORAGE.md](MASTER_STORAGE.md). Railway 서버 모드의 전체 초기화는 비활성화했다.
