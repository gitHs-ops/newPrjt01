/* newPrjt01 — 진로상담 공통 로직
   저장소 · 설정 · AI 호출 · 마크다운 렌더 · md 저장 · 옵시디언 전송(스텁)

   의존: assets/auth.js (세션), assets/career-prompts.js (프롬프트 원문)
   전역: window.Career
*/
(function (g) {
    'use strict';

    /* 이 클라이언트가 기대하는 프록시 버전.
       tools/career_proxy.example.gs 의 PROXY_VERSION 과 맞춰 둔다.
       배포본이 낮으면 결과 화면에서 "프록시가 낡았다"고 알려 준다 —
       파일을 고쳐 놓고 재배포를 잊는 일이 반복돼 넣었다. */
    var EXPECTED_PROXY_VERSION = '1.7.1';

    var CASES_KEY  = 'np_career_cases';
    var CONFIG_KEY = 'np_career_config';

    /* =========================================================
       설정
       ---------------------------------------------------------
       endpoint / apiKey / 옵시디언 접속정보는 모두 "추후 결정" 항목이다.
       비어 있으면 UI 가 미설정 상태를 표시하고, 분석은 모의 모드로만 돌아간다.
       ========================================================= */
    /* 진로상담 프롬프트가 "공식 정보 출처 제한" 절에서 지정한 기관 도메인.
       [공식자료 우선] 옵션을 켜면 웹검색을 이 목록으로 제한한다.
       ⚠ 대학 입학처는 학교마다 도메인이 달라 여기에 담을 수 없다 —
          켜면 STEP 7-3(대학 정보·입시결과) 조회가 막힌다. 기본값을 끔으로 두는 이유다. */
    var OFFICIAL_DOMAINS = [
        'career.go.kr',        /* 커리어넷 — 직업·학과정보 */
        'work.go.kr',          /* 고용24 */
        'keis.or.kr',          /* 한국고용정보원 */
        'moel.go.kr',          /* 고용노동부 */
        'kosis.kr',            /* 국가통계포털 */
        'kostat.go.kr',        /* 통계청 */
        'motie.go.kr',         /* 산업통상자원부 */
        'kiet.re.kr',          /* 산업연구원 */
        'mss.go.kr',           /* 중소벤처기업부 */
        'msit.go.kr',          /* 과학기술정보통신부 */
        'moe.go.kr',           /* 교육부 */
        'ncic.re.kr',          /* 국가교육과정정보센터 */
        'adiga.kr',            /* 대입정보포털 어디가 */
        'academyinfo.go.kr',   /* 대학알리미 — 취업률 */
        'q-net.or.kr',         /* 자격 */
        'dart.fss.or.kr'       /* 전자공시 */
    ];

    var DEFAULT_CONFIG = {
        /* --- AI 호출 (careerTest 의 GAS 프록시와 같은 방식) --- */
        endpoint: '',          /* 예: https://script.google.com/macros/s/.../exec  — 추후 결정 */
        model: 'claude-haiku-4-5',
        maxTokens1: 12000,
        maxTokens2: 12000,
        allowMock: true,       /* 엔드포인트 미설정 시 모의 응답으로 흐름 검증 */

        /* --- 공식자료 웹검색 (프록시의 서버사이드 web_search 도구) --- */
        webSearch: true,       /* 끄면 모델 기억만으로 답한다 — 프롬프트가 금지하는 상태 */
        searchMaxUses: 6,      /* 한 번의 분석에서 허용할 검색 횟수 */
        officialOnly: false,   /* 켜면 위 OFFICIAL_DOMAINS 로 검색을 제한 */

        /* 사고 깊이. 실행시간을 좌우한다 —
           프록시가 Apps Script 라면 실행 한도(개인 계정 6분)가 있어 낮게 시작해야 한다. */
        effort: 'low',

        /* 응답 대기 상한(초). Apps Script 는 6분에 강제 종료되므로 그보다 조금 길게 잡는다.
           이게 없으면 서버가 죽어도 브라우저가 무한정 기다린다. */
        timeoutSec: 400,

        /* --- Obsidian Local REST API (기능 표시만, 연결은 추후 결정) --- */
        obsidian: {
            enabled: false,    /* 주소·키가 채워지면 켤 수 있다 */
            /* HTTPS(27124)는 자체서명 인증서라 브라우저가 막는다.
               플러그인 설정에서 비암호화 HTTP 를 켜고 27123 을 쓰는 편이 마찰이 없다. */
            baseUrl: 'http://127.0.0.1:27123',
            apiKey: '',
            folder: '진로상담'
        }
    };

    function loadConfig() {
        var raw = null;
        try { raw = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null'); } catch (e) { raw = null; }
        var c = {};
        for (var k in DEFAULT_CONFIG) {
            if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, k)) c[k] = DEFAULT_CONFIG[k];
        }
        c.obsidian = {
            enabled: DEFAULT_CONFIG.obsidian.enabled,
            baseUrl: DEFAULT_CONFIG.obsidian.baseUrl,
            apiKey: DEFAULT_CONFIG.obsidian.apiKey,
            folder: DEFAULT_CONFIG.obsidian.folder
        };
        if (raw && typeof raw === 'object') {
            if (typeof raw.endpoint === 'string')  c.endpoint  = raw.endpoint.trim();
            if (typeof raw.model === 'string' && raw.model) c.model = raw.model.trim();
            if (raw.maxTokens1 > 0) c.maxTokens1 = raw.maxTokens1 | 0;
            if (raw.maxTokens2 > 0) c.maxTokens2 = raw.maxTokens2 | 0;
            /* 저장된 설정이 기본값을 덮어쓰므로, 기본값만 올려서는 기존 사용자에게 적용되지 않는다.
               2차 보고서가 STEP 11(최종 브리프)까지 나오려면 6000 으로는 모자라 실제로 잘렸다.
               옛 기본값 그대로인 설정은 새 기본값으로 끌어올린다. 손으로 더 크게 잡아 둔 값은 존중. */
            if (c.maxTokens1 < DEFAULT_CONFIG.maxTokens1) c.maxTokens1 = DEFAULT_CONFIG.maxTokens1;
            if (c.maxTokens2 < DEFAULT_CONFIG.maxTokens2) c.maxTokens2 = DEFAULT_CONFIG.maxTokens2;
            if (typeof raw.allowMock === 'boolean') c.allowMock = raw.allowMock;
            if (typeof raw.webSearch === 'boolean') c.webSearch = raw.webSearch;
            if (raw.searchMaxUses > 0) c.searchMaxUses = raw.searchMaxUses | 0;
            if (typeof raw.officialOnly === 'boolean') c.officialOnly = raw.officialOnly;
            if (typeof raw.effort === 'string' && raw.effort) c.effort = raw.effort;
            if (raw.timeoutSec > 0) c.timeoutSec = raw.timeoutSec | 0;
            if (raw.obsidian && typeof raw.obsidian === 'object') {
                if (typeof raw.obsidian.baseUrl === 'string') c.obsidian.baseUrl = raw.obsidian.baseUrl.trim();
                if (typeof raw.obsidian.apiKey === 'string')  c.obsidian.apiKey  = raw.obsidian.apiKey;
                if (typeof raw.obsidian.folder === 'string')  c.obsidian.folder  = raw.obsidian.folder.trim();
                /* enabled 는 저장값을 읽되, 접속정보가 없으면 강제로 끈다 */
                c.obsidian.enabled = !!raw.obsidian.enabled &&
                                     !!c.obsidian.baseUrl && !!c.obsidian.apiKey;
            }
        }
        return c;
    }

    function saveConfig(patch) {
        var c = loadConfig();
        if (patch && typeof patch === 'object') {
            for (var k in patch) {
                if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
                if (k === 'obsidian' && patch.obsidian) {
                    for (var o in patch.obsidian) {
                        if (Object.prototype.hasOwnProperty.call(patch.obsidian, o)) c.obsidian[o] = patch.obsidian[o];
                    }
                } else { c[k] = patch[k]; }
            }
        }
        localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
        return c;
    }

    /* AI 연결 상태: ready(엔드포인트 있음) / mock(모의) / off(불가) */
    function aiStatus() {
        var c = loadConfig();
        if (c.endpoint) return 'ready';
        return c.allowMock ? 'mock' : 'off';
    }

    /* =========================================================
       사례 저장소 (localStorage)
       ========================================================= */
    function nowIso() { return new Date().toISOString(); }

    function newId() {
        return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function readAll() {
        try {
            var a = JSON.parse(localStorage.getItem(CASES_KEY) || '[]');
            return Array.isArray(a) ? a : [];
        } catch (e) { return []; }
    }

    function writeAll(list) {
        localStorage.setItem(CASES_KEY, JSON.stringify(list));
    }

    /* 현재 로그인 사용자의 사례만 (세션이 없으면 소유자 '-') */
    function currentOwner() {
        try {
            var s = (g.Auth && Auth.getSession) ? Auth.getSession() : null;
            return (s && s.id) ? s.id : '-';
        } catch (e) { return '-'; }
    }

    function listCases() {
        var owner = currentOwner();
        return readAll()
            .filter(function (c) { return c.owner === owner; })
            .sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
    }

    function getCase(id) {
        var all = readAll();
        for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
        return null;
    }

    function createCase(label, student) {
        var c = {
            id: newId(),
            owner: currentOwner(),
            label: (label || '').trim() || '이름 없는 사례',
            createdAt: nowIso(),
            updatedAt: nowIso(),
            student: student || {},
            report1: null,   /* { md, at, mock, usage } */
            extra2: null,    /* 2차 입력 */
            report2: null
        };
        var all = readAll();
        all.push(c);
        writeAll(all);
        return c;
    }

    function updateCase(id, patch) {
        var all = readAll();
        for (var i = 0; i < all.length; i++) {
            if (all[i].id !== id) continue;
            for (var k in patch) {
                if (Object.prototype.hasOwnProperty.call(patch, k)) all[i][k] = patch[k];
            }
            all[i].updatedAt = nowIso();
            writeAll(all);
            return all[i];
        }
        return null;
    }

    function deleteCase(id) {
        writeAll(readAll().filter(function (c) { return c.id !== id; }));
    }

    /* =========================================================
       입력 → 프롬프트용 사용자 메시지
       ========================================================= */

    /* 1차 입력 항목 정의 — assets/prompts/input-1st.txt 와 1:1 대응 */
    var FIELDS_1 = [
        { key: 'grade',     label: '학교급 및 학년',              required: true  },
        { key: 'hope',      label: '희망 직업 / 직무 / 계열',      required: true  },
        { key: 'subjects',  label: '현재 관심 과목 및 강점',        required: true  },
        { key: 'industry',  label: '관심 있는 산업 또는 분야',      required: false },
        { key: 'trigger',   label: '관심을 갖게 된 계기',          required: false },
        { key: 'style',     label: '좋아하는 활동 또는 문제해결 방식', required: false },
        { key: 'major',     label: '현재 생각하고 있는 전공',       required: false },
        { key: 'score',     label: '현재 교과 성적 또는 대략적인 수준', required: false },
        { key: 'univ',      label: '희망 대학 또는 대학 수준',      required: false },
        { key: 'region',    label: '희망 지역',                   required: false },
        { key: 'entryYear', label: '대학 진학 예정 연도',          required: false },
        { key: 'ask',       label: '추가적으로 알고 싶은 내용',      required: false }
    ];

    /* 2차 — 학생의 추가 경험·행동 정보 */
    var FIELDS_2_EXP = [
        { key: 'memorable', label: '기억에 남는 수행평가' },
        { key: 'liked',     label: '좋아했던 활동' },
        { key: 'disliked',  label: '싫었던 활동' },
        { key: 'retry',     label: '실패했지만 다시 해보고 싶은 경험' },
        { key: 'teamRole',  label: '조별활동에서 주로 맡는 역할' },
        { key: 'asked',     label: '친구들이 자주 부탁하는 일' },
        { key: 'alone',     label: '혼자 있을 때 자주 하는 활동' },
        { key: 'goodResult', label: '결과가 좋았던 경험' },
        { key: 'selfGood',  label: '학생이 스스로 잘한다고 느끼는 것' }
    ];

    /* 2차 — 학교 자료 정보 */
    var FIELDS_2_SCHOOL = [
        { key: 'grades',   label: '교과성적' },
        { key: 'sebu',     label: '세부능력 및 특기사항' },
        { key: 'perform',  label: '수행평가' },
        { key: 'inquiry',  label: '탐구활동' },
        { key: 'club',     label: '동아리' },
        { key: 'autonomy', label: '자율활동' },
        { key: 'careerAct', label: '진로활동' },
        { key: 'etc',      label: '기타 학생을 이해하는 데 필요한 학교자료' }
    ];

    /* =========================================================
       입력 보조 — 드롭다운 선택지
       ---------------------------------------------------------
       매번 자유입력을 채우는 부담을 줄인다. 단일 선택 항목은 select 가 값을 그대로 넣고,
       여러 개를 고를 수 있는 항목은 "빠른 추가" select 가 textarea 에 덧붙인다.
       ⚠ 희망 직업·직무는 드롭다운으로 만들지 않는다 —
          프롬프트 STEP 0 이 "학생이 말한 표현" 자체를 해석 대상으로 삼기 때문이다.
       ========================================================= */
    var CHOICES = {
        /* 성적은 학교급에 따라 체계가 다르다. 중학교에 "등급"을 쓰면 프롬프트가
           일관성 검증에서 [확인 필요] 로 걸어야 하는 모순이 된다. */
        score: {
            중학교: ['성취도 A (90점 이상)', '성취도 B (80점대)', '성취도 C (70점대)',
                     '성취도 D (60점대)', '성취도 E (60점 미만)',
                     '전반적으로 상위권', '전반적으로 중위권', '전반적으로 하위권'],
            고등학교: ['내신 1~2등급', '내신 3~4등급', '내신 5~6등급', '내신 7~9등급',
                       '과목별 편차가 큼', '전반적으로 상위권', '전반적으로 중위권', '전반적으로 하위권']
        },
        univ: ['최상위권 대학', '수도권 상위권 대학', '수도권 4년제', '지방 거점 국립대',
               '지방 4년제', '전문대학', '특성화대학·폴리텍', '아직 정하지 않음'],
        region: ['서울', '수도권(경기·인천)', '충청권', '강원권', '영남권(부산·대구·경남북)',
                 '호남권', '제주', '지역은 상관없음', '아직 정하지 않음'],
        subject: ['국어', '영어', '수학', '통합과학', '물리', '화학', '생명과학', '지구과학',
                  '정보·컴퓨터', '기술·가정', '사회', '역사', '지리', '경제',
                  '미술', '음악', '체육', '제2외국어'],
        industry: ['반도체', '디스플레이', '이차전지', '자동차·모빌리티', '조선·해양', '항공우주',
                   '로봇·자동화', 'AI·소프트웨어', '게임', '콘텐츠·미디어', '바이오·제약', '의료·헬스케어',
                   '화학·소재', '에너지·신재생', '건설·인프라', '금융', '물류·유통', '식품',
                   '환경·탄소중립', '교육', '공공·행정'],
        trigger: ['수업에서 배우고 흥미가 생김', '동아리 활동', '다큐멘터리·영상', '뉴스·기사',
                  '책', '게임·취미', '가족·지인의 영향', '진로체험·박람회', '학교 진로수업',
                  '친구 이야기', '특정 기업·제품을 보고'],
        /* 2차 프롬프트가 열거한 '일하는 방식' 9종을 그대로 쓴다 —
           1차 입력과 2차 분석의 어휘를 맞추면 대조가 쉬워진다. */
        workStyle: ['원리 탐구 — 왜 그런지 알아내는 것', '분석·문제해결 — 원인을 찾아 하나씩 확인',
                    '설계·개발 — 구조나 방법을 새로 만드는 것', '제작·현장 — 도구·장비를 직접 다루는 것',
                    '기획·구조화 — 목표와 순서를 세우는 것', '데이터·계산 — 숫자와 패턴으로 푸는 것',
                    '설명·소통 — 이해한 것을 남에게 설명하는 것', '사람지원 — 남을 돕고 문제를 풀어주는 것',
                    '표현·콘텐츠 — 글·영상·디자인으로 표현하는 것'],
        major: ['전자공학과', '전기공학과', '기계공학과', '컴퓨터공학과', '소프트웨어학과',
                '신소재공학과', '화학공학과', '산업공학과', '조선해양공학과', '항공우주공학과',
                '건축학과', '토목공학과', '생명공학과', '의예과', '간호학과', '약학과',
                '물리학과', '화학과', '수학과', '통계학과', '경영학과', '경제학과',
                '심리학과', '교육학과', '디자인학과', '미디어커뮤니케이션학과'],
        teamRole: ['기획·리더 역할', '자료조사', '발표', '정리·기록', '제작·실습',
                   '아이디어 제시', '갈등 조정', '특별히 정해진 역할 없음'],
        askedFor: ['공부·과제 설명해 주기', '문제 풀이 도와주기', '컴퓨터·기기 문제 해결',
                   '발표 맡기', '자료 정리·정돈', '만들기·꾸미기', '중재·상담',
                   '특별히 부탁받는 일 없음']
    };

    /* 학년으로 대학 진학 예정 연도를 계산한다.
       프롬프트가 "현재 학년과 진학 예정 연도가 일치하는가"를 검증 항목으로 두고 있어,
       손으로 넣다 어긋나면 분석이 [확인 필요] 로 새 버린다. */
    function entryYearFor(grade) {
        var m = /(중학교|고등학교)\s*([1-3])학년/.exec(String(grade || ''));
        if (!m) return '';
        var left = (m[1] === '고등학교' ? 3 : 6) - parseInt(m[2], 10);  /* 남은 학년 수 */
        return String(new Date().getFullYear() + left + 1);
    }

    /* select 의 선택값을 textarea 에 덧붙인다(중복은 무시). 고른 뒤 select 는 초기화. */
    function bindQuickPick(selectId, targetId, sep) {
        var sel = document.getElementById(selectId);
        var box = document.getElementById(targetId);
        if (!sel || !box) return;
        sep = sep || ', ';
        sel.addEventListener('change', function () {
            var v = sel.value;
            sel.selectedIndex = 0;
            if (!v) return;
            var cur = box.value.trim();
            if (cur.split(/\s*,\s*|\n/).indexOf(v) >= 0) return;
            box.value = cur ? cur + sep + v : v;
            box.dispatchEvent(new Event('input', { bubbles: true }));
            box.focus();
        });
    }

    /* select 요소를 옵션 배열로 채운다 */
    function fillSelect(el, items, placeholder) {
        if (!el) return;
        el.innerHTML = '';
        var o0 = document.createElement('option');
        o0.value = '';
        o0.textContent = placeholder || '선택하세요';
        el.appendChild(o0);
        (items || []).forEach(function (t) {
            var o = document.createElement('option');
            o.value = t;
            o.textContent = t;
            el.appendChild(o);
        });
    }

    function line(label, value) {
        var v = (value == null ? '' : String(value)).trim();
        return '* ' + label + ': ' + (v || '(입력 없음)');
    }

    function buildUserMessage1(student) {
        var out = ['[입력 데이터]', '', '# 학생 정보', ''];
        FIELDS_1.forEach(function (f) { out.push(line(f.label, student[f.key])); });
        return out.join('\n');
    }

    function buildUserMessage2(report1Md, extra) {
        var out = ['[입력 데이터]', '', '## [1차 진로·산업·진학 리서치 결과]', ''];
        out.push(report1Md && report1Md.trim() ? report1Md.trim() : '(1차 분석 결과 없음)');
        out.push('');
        out.push('## [학생의 추가 경험·행동 정보]');
        out.push('');
        if (extra && extra.hasExp === 'yes') {
            FIELDS_2_EXP.forEach(function (f) { out.push(line(f.label, extra.exp ? extra.exp[f.key] : '')); });
        } else {
            out.push('추가 정보 없음');
        }
        out.push('');
        out.push('## [학교 자료 정보]');
        out.push('');
        if (extra && extra.hasSchool === 'yes') {
            FIELDS_2_SCHOOL.forEach(function (f) { out.push(line(f.label, extra.school ? extra.school[f.key] : '')); });
        } else {
            out.push('학교자료 없음');
        }
        out.push('');
        out.push('## [교사가 특별히 확인하고 싶은 내용]');
        out.push('');
        var t = (extra && extra.teacherAsk ? String(extra.teacherAsk) : '').trim();
        out.push(t || '(입력 없음)');
        return out.join('\n');
    }

    /* =========================================================
       AI 호출
       ---------------------------------------------------------
       프록시 계약(추후 확정):
         POST <endpoint>   Content-Type: text/plain  (GAS preflight 회피)
         body: {"system": "...", "prompt": "...", "max_tokens": 8000, "model": "..."}
         200 : {"text": "...", "usage": {...}, "error": null}
       careerTest/career_proxy.gs 와 동일한 응답 형태를 전제로 한다.
       ========================================================= */
    function callAI(opts) {
        var cfg = loadConfig();
        var endpoint = cfg.endpoint;

        if (!endpoint) {
            if (!cfg.allowMock) {
                return Promise.reject(new Error(
                    'AI 엔드포인트가 설정되지 않았습니다. 우측 상단 연결 설정에서 프록시 URL을 입력하세요.'));
            }
            return mockAnswer(opts).then(function (md) {
                return { text: md, usage: null, sources: [], searches: 0,
                         truncated: false, incomplete: false, elapsedMs: 0, mock: true };
            });
        }

        var payload = {
            system: opts.system || '',
            prompt: opts.user || '',
            max_tokens: opts.maxTokens || 4000,
            model: cfg.model,
            /* 사용량 로그용 식별자 — 프록시가 구글 시트에 사용자별로 기록한다.
               사례 '이름'은 보내지 않는다(로컬 라벨). 식별에는 사례 id 로 충분하다. */
            user: currentOwner(),
            case_id: opts.caseId || '',
            round: opts.round || 1,
            /* 프록시가 서버사이드 web_search 도구를 켜도록 지시한다.
               이게 없으면 모델 기억만으로 답해 "확인 불가"가 대량으로 나온다. */
            web_search: !!cfg.webSearch,
            search_max_uses: cfg.searchMaxUses,
            effort: cfg.effort
        };
        if (cfg.webSearch && cfg.officialOnly) {
            payload.allowed_domains = OFFICIAL_DOMAINS.slice();
        }

        /* ⚠ 반드시 타임아웃을 건다.
           Apps Script 는 실행 6분에서 강제 종료되는데, 그때 응답을 돌려주지 못하면
           브라우저 fetch 는 기본적으로 "무한정" 기다린다 —
           2026-09-01 실제로 한 시간 동안 매달렸다. 서버가 죽어도 화면은 끝나야 한다. */
        var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timedOut = false;
        var timer = setTimeout(function () {
            timedOut = true;
            if (ctl) ctl.abort();
        }, cfg.timeoutSec * 1000);

        var opt = {
            method: 'POST',
            /* text/plain 이어야 GAS 웹앱에서 CORS preflight 없이 통과한다 */
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        };
        if (ctl) opt.signal = ctl.signal;

        return fetch(endpoint, opt).catch(function () {
            if (timedOut) {
                throw new Error(
                    cfg.timeoutSec + '초 안에 응답이 오지 않아 중단했습니다.\n\n' +
                    'Apps Script 는 실행 6분에서 강제 종료되므로, 이보다 오래 걸리면 ' +
                    '결과를 받을 수 없습니다. 다음을 줄여 보세요.\n' +
                    '· 검색 횟수(현재 ' + cfg.searchMaxUses + '회)\n' +
                    '· 사고 깊이 effort(현재 ' + cfg.effort + ')\n' +
                    '· max_tokens\n\n' +
                    '프록시 쪽에서는 Apps Script 편집기의 test1_key / test2_search 로 ' +
                    '어느 단계가 느린지 먼저 재 보십시오.');
            }
            /* fetch 자체가 실패 — 주소 오타 · 서버 다운 · CORS 차단 */
            throw new Error('프록시에 연결하지 못했습니다. 주소가 맞는지, 프록시가 응답하는지, ' +
                            'CORS 를 허용하는지 확인하세요. (' + endpoint + ')');
        }).then(function (res) {
            clearTimeout(timer);
            if (!res.ok) throw new Error('서버 오류 (HTTP ' + res.status + ')');
            return res.json();
        }).then(function (data) {
            clearTimeout(timer);
            if (data && data.error) throw new Error(String(data.error));
            var text = (data && data.text) ? String(data.text) : '';
            if (!text.trim()) throw new Error('응답이 비어 있습니다.');
            return {
                text: stripFence(text),
                usage: (data && data.usage) || null,
                /* 프록시가 돌려준 웹검색 흔적. 구버전 프록시면 없을 수 있다. */
                sources: (data && data.sources) || [],
                searches: (data && data.searches) || 0,
                truncated: !!(data && data.truncated),
                /* 프록시가 시간이 모자라 검색 루프를 끊었다는 표시 */
                incomplete: !!(data && data.incomplete),
                elapsedMs: (data && data.elapsed_ms) || 0,
                /* 프록시가 잘린 응답을 이어붙인 횟수 */
                continued: (data && data.continued) || 0,
                /* 프록시가 시트에 기록하지 못한 사유(있을 때만) */
                logError: (data && data.log_error) || '',
                proxyVersion: (data && data.proxy_version) || '',
                proxyStale: isStaleProxy((data && data.proxy_version) || ''),
                mock: false
            };
        });
    }

    /* 배포된 프록시가 기대 버전보다 낮은가. 버전을 안 실어 보내면(구버전) 그것도 낡은 것이다. */
    function isStaleProxy(v) {
        if (!v) return true;
        var a = String(v).split('.').map(Number);
        var b = EXPECTED_PROXY_VERSION.split('.').map(Number);
        for (var i = 0; i < 3; i++) {
            if ((a[i] || 0) < (b[i] || 0)) return true;
            if ((a[i] || 0) > (b[i] || 0)) return false;
        }
        return false;
    }

    function stripFence(t) {
        return String(t)
            .replace(/^\s*```(?:markdown|md)?\s*\n/i, '')
            .replace(/\n```\s*$/, '')
            .trim();
    }

    /* ---- 모의 응답 : 엔드포인트 미설정 상태에서 화면 흐름을 검증하기 위한 것 ----
       실제 조사를 하지 않으므로 사실 정보를 지어내지 않고,
       입력값을 되짚어 주면서 확인 불가 항목을 명시한다.                        */
    function mockAnswer(opts) {
        var delay = 700 + Math.floor(Math.random() * 500);
        return new Promise(function (resolve) {
            setTimeout(function () { resolve(opts.round === 2 ? mockMd2(opts) : mockMd1(opts)); }, delay);
        });
    }

    function mockMd1(opts) {
        var s = opts.student || {};
        var v = function (k, d) { return (s[k] && String(s[k]).trim()) || (d || '(입력 없음)'); };
        return [
            '# 1차 진로·산업·진학 리서치 (모의 응답)',
            '',
            '> ⚠ **이 문서는 AI 엔드포인트가 설정되지 않아 생성된 모의 응답입니다.**',
            '> 화면 흐름과 저장 기능을 검증하기 위한 자리표시자이며, 실제 조사 결과가 아닙니다.',
            '> 실제 분석을 하려면 연결 설정에서 프록시 URL을 입력하십시오.',
            '',
            '## A. 진로교사용 핵심 브리프',
            '',
            '| 항목 | 내용 |',
            '| --- | --- |',
            '| 학생의 현재 희망 | [학생 입력] ' + v('hope') + ' |',
            '| 희망의 현재 수준 | [확인 필요] 직업/직무/산업/전공/기업 중 무엇인지 상담에서 확인 |',
            '| 연결 가능한 대표 직무 | [확인 불가 — 최신 공식자료 조회 필요] |',
            '| 관심과 연결되는 대표 산업 | [학생 입력] ' + v('industry') + ' |',
            '| 직무의 핵심 역할 | [확인 불가 — 최신 공식자료 조회 필요] |',
            '| 주요 관련 전공 | [학생 입력] ' + v('major') + ' |',
            '| 고교에서 중요한 교과 영역 | [학생 입력] ' + v('subjects') + ' |',
            '| 상담에서 가장 먼저 확인할 부분 | 희망 표현이 직업인지 산업인지 구분 |',
            '',
            '## B. 희망 진로 세분화',
            '',
            '* [학생 입력] 학교급 및 학년: ' + v('grade'),
            '* [학생 입력] 희망: ' + v('hope'),
            '* [학생 입력] 관심 과목 및 강점: ' + v('subjects'),
            '* [학생 입력] 관심 산업: ' + v('industry'),
            '* [학생 입력] 진학 예정 연도: ' + v('entryYear'),
            '* [확인 불가 — 최신 공식자료 조회 필요] 직무·산업·전공의 실제 연결 관계',
            '',
            '## L. 출처 및 신뢰도',
            '',
            '| 기관 | 자료명 | 기준연도·확인시점 | 활용 내용 |',
            '| --- | --- | --- | --- |',
            '| — | 모의 응답이므로 조회한 공식자료 없음 | — | — |',
            '',
            '### 현재 공식자료로 확인된 내용',
            '',
            '없음 (모의 응답)',
            '',
            '### 현재 확인할 수 없는 내용',
            '',
            '직무·산업·전공·입시·자격·고용 관련 모든 항목',
            '',
            '### 상담에서의 해석',
            '',
            '[제안] 실제 분석 전까지 이 문서를 상담자료로 사용하지 마십시오.',
            '',
            '본 자료는 진로상담을 시작하기 위한 1차 정보이며, 학생의 진로를 확정하거나 특정 대학의 합격 가능성을 보장하는 자료가 아닙니다.'
        ].join('\n');
    }

    function mockMd2(opts) {
        var e = opts.extra || {};
        return [
            '# 2차 진로상담 분석 (모의 응답)',
            '',
            '> ⚠ **이 문서는 AI 엔드포인트가 설정되지 않아 생성된 모의 응답입니다.**',
            '> 화면 흐름과 저장 기능을 검증하기 위한 자리표시자이며, 실제 분석 결과가 아닙니다.',
            '',
            '## STEP 1. 1차 분석 핵심만 다시 정리',
            '',
            '| 항목 | 1차 분석에서 제시된 내용 |',
            '| --- | --- |',
            '| 학생의 현재 관심 | 1차 결과 본문 참조 |',
            '| 대표 직무 후보 | [추가 확인] |',
            '| 대표 산업 | [추가 확인] |',
            '',
            '## STEP 2. 학생의 실제 근거 정리',
            '',
            '* 추가 경험·행동 정보: ' + (e.hasExp === 'yes' ? '제공됨' : '추가 정보 없음'),
            '* 학교 자료: ' + (e.hasSchool === 'yes' ? '제공됨' : '학교자료 없음'),
            '* 교사 확인 요청: ' + ((e.teacherAsk || '').trim() || '(입력 없음)'),
            '',
            '## STEP 11. 최종 2차 상담 브리프',
            '',
            '### 현재 비교적 근거가 있는 강점 후보',
            '',
            '[추가 확인] — 모의 응답이므로 판단하지 않습니다.',
            '',
            '### 현재 탐색 가치가 높은 진로 가설',
            '',
            '[추가 확인] — 실제 분석 필요',
            '',
            '### 다음 상담에서 가장 먼저 물어볼 질문',
            '',
            '실제 분석을 먼저 수행하십시오.',
            '',
            '**본 2차 분석은 1차 진로리서치에서 발견한 가능성을 학생의 실제 경험과 학교자료를 통해 검토하고, 다음 상담에서 확인할 진로 가설과 탐색 행동을 정하기 위한 보조자료입니다. 학생의 적성·직업·전공을 확정하는 자료가 아닙니다.**'
        ].join('\n');
    }

    /* =========================================================
       마크다운 → HTML (외부 라이브러리 없음)
       AI 응답을 그리므로 반드시 이스케이프 후 제한된 태그만 복원한다.
       ========================================================= */
    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function inline(s) {
        var t = esc(s);
        t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
        t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
        t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
        return t;
    }

    function splitRow(row) {
        var cells = row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
        return cells.map(function (c) { return c.trim(); });
    }

    function mdToHtml(md) {
        var lines = String(md == null ? '' : md).replace(/\r\n/g, '\n').split('\n');
        var out = [];
        var i = 0;

        function isTableSep(s) { return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(s) && s.indexOf('-') >= 0; }

        while (i < lines.length) {
            var ln = lines[i];

            /* 코드블록 */
            var fence = ln.match(/^\s*```(\w*)\s*$/);
            if (fence) {
                var buf = [];
                i++;
                while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
                i++;
                out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
                continue;
            }

            /* 표 */
            if (/\|/.test(ln) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
                var head = splitRow(ln);
                i += 2;
                var rows = [];
                while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') {
                    rows.push(splitRow(lines[i]));
                    i++;
                }
                var th = head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('');
                var tb = rows.map(function (r) {
                    var tds = [];
                    for (var c = 0; c < head.length; c++) tds.push('<td>' + inline(r[c] || '') + '</td>');
                    return '<tr>' + tds.join('') + '</tr>';
                }).join('');
                out.push('<table><thead><tr>' + th + '</tr></thead><tbody>' + tb + '</tbody></table>');
                continue;
            }

            /* 제목 */
            var h = ln.match(/^(#{1,6})\s+(.*)$/);
            if (h) {
                var lv = Math.min(h[1].length, 4);
                out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>');
                i++;
                continue;
            }

            /* 수평선 */
            if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) { out.push('<hr>'); i++; continue; }

            /* 인용 */
            if (/^\s*>\s?/.test(ln)) {
                var q = [];
                while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
                    q.push(lines[i].replace(/^\s*>\s?/, ''));
                    i++;
                }
                out.push('<blockquote>' + mdToHtml(q.join('\n')) + '</blockquote>');
                continue;
            }

            /* 목록 (중첩 1단계까지) */
            if (/^\s*([-*+]|\d+\.)\s+/.test(ln)) {
                var ordered = /^\s*\d+\.\s+/.test(ln);
                var items = [];
                while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
                    var indent = (lines[i].match(/^\s*/) || [''])[0].length;
                    var text = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '');
                    items.push({ indent: indent, text: text });
                    i++;
                }
                out.push(renderList(items, ordered));
                continue;
            }

            /* 빈 줄 */
            if (ln.trim() === '') { i++; continue; }

            /* 문단 */
            var para = [];
            while (i < lines.length && lines[i].trim() !== '' &&
                   !/^(#{1,6})\s/.test(lines[i]) &&
                   !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
                   !/^\s*>/.test(lines[i]) &&
                   !/^\s*```/.test(lines[i]) &&
                   !(/\|/.test(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
                para.push(lines[i]);
                i++;
            }
            out.push('<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
        }
        return out.join('\n');
    }

    function renderList(items, ordered) {
        var base = items.length ? items[0].indent : 0;
        var tag = ordered ? 'ol' : 'ul';
        var html = '<' + tag + '>';
        var open = false;
        var nested = null;
        items.forEach(function (it) {
            if (it.indent > base) {
                if (!nested) nested = [];
                nested.push(it);
                return;
            }
            if (nested) {
                html += renderList(nested, false);
                nested = null;
            }
            if (open) html += '</li>';
            html += '<li>' + inline(it.text);
            open = true;
        });
        if (nested) html += renderList(nested, false);
        if (open) html += '</li>';
        return html + '</' + tag + '>';
    }

    /* =========================================================
       md 파일 생성 / 저장
       ========================================================= */
    function pad(n) { return String(n).padStart(2, '0'); }

    function stamp(d) {
        d = d || new Date();
        return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
               pad(d.getHours()) + pad(d.getMinutes());
    }

    function fmtDateTime(iso) {
        try {
            var d = new Date(iso);
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
                   pad(d.getHours()) + ':' + pad(d.getMinutes());
        } catch (e) { return String(iso || ''); }
    }

    function safeName(s) {
        return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || '사례';
    }

    function fileName(kase, round) {
        return '진로' + round + '차_' + safeName(kase.label) + '_' + stamp(new Date()) + '.md';
    }

    /* 보고서 본문에 상담 메타데이터 머리말을 붙인다 (옵시디언 프론트매터) */
    function withFrontMatter(kase, round, md, mock) {
        var fm = [
            '---',
            'title: "진로상담 ' + round + '차 분석 — ' + String(kase.label).replace(/"/g, '\\"') + '"',
            'case_id: ' + kase.id,
            'round: ' + round,
            'created: ' + new Date().toISOString(),
            'source: newPrjt01 career',
            'mock: ' + (mock ? 'true' : 'false'),
            'tags: [진로상담, ' + round + '차분석]',
            '---',
            ''
        ].join('\n');
        return fm + md;
    }

    function downloadMd(name, content) {
        var blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    }

    /* =========================================================
       Obsidian Local REST API — 볼트로 직접 전송
       ---------------------------------------------------------
         PUT {baseUrl}/vault/{folder}/{file}.md
         Authorization: Bearer {apiKey}
         Content-Type: text/markdown

       2026-09-01 실측(tools/obsidian-check.html)으로 확인한 것:
         · 27123(HTTP) 도달 · CORS 통과 · Authorization preflight 통과 · 키 인증 200
       HTTPS(27124)는 자체서명 인증서라 브라우저가 거부한다 —
       플러그인 설정에서 비암호화 HTTP 를 켜고 27123 을 쓰는 편이 마찰이 없다.
       ========================================================= */
    var OBSIDIAN_PENDING_MSG =
        '옵시디언 전송이 설정되지 않았습니다.\n\n' +
        '우측 상단 [연결 설정] → 옵시디언 전송에서 주소·API 키·폴더를 넣고 ' +
        '“연결 테스트”가 통과하면 사용할 수 있습니다.\n\n' +
        '설정 전에는 md 파일로 저장한 뒤 볼트에 옮겨 주십시오.';

    function obsidianReady() {
        var c = loadConfig().obsidian;
        return !!(c.enabled && c.baseUrl && c.apiKey);
    }

    /* 볼트 기준 경로. 폴더·파일명에 한글이 들어가므로 인코딩이 필요하다.
       encodeURI 는 '/' 를 남기므로 경로 구분자가 깨지지 않는다. */
    function vaultUrl(cfg, name) {
        var path = cfg.folder ? (cfg.folder.replace(/^\/+|\/+$/g, '') + '/' + name) : name;
        return cfg.baseUrl.replace(/\/+$/, '') + '/vault/' + encodeURI(path);
    }

    /* 실패 원인을 사람이 읽을 수 있는 말로 바꾼다 —
       fetch 는 연결거부·CORS·인증서 실패를 전부 'Failed to fetch' 로 뭉뚱그린다. */
    function obsidianNetworkError(cfg) {
        var https = cfg.baseUrl.indexOf('https:') === 0;
        return new Error(
            '옵시디언에 연결하지 못했습니다 (' + cfg.baseUrl + ').\n\n' +
            '· 옵시디언이 실행 중이고 Local REST API 플러그인이 켜져 있는지\n' +
            '· 주소·포트가 맞는지\n' +
            (https ? '· HTTPS(27124)는 자체서명 인증서라 브라우저가 막습니다 —\n' +
                     '  플러그인 설정에서 비암호화 HTTP 를 켜고 27123 을 쓰는 것을 권합니다\n' : '') +
            '\n자세한 진단은 tools/obsidian-check.html 에서 할 수 있습니다.');
    }

    function sendToObsidian(name, content) {
        var cfg = loadConfig().obsidian;
        if (!obsidianReady()) return Promise.reject(new Error(OBSIDIAN_PENDING_MSG));

        return fetch(vaultUrl(cfg, name), {
            method: 'PUT',
            mode: 'cors',
            headers: {
                'Authorization': 'Bearer ' + cfg.apiKey,
                'Content-Type': 'text/markdown; charset=utf-8'
            },
            body: content
        }).catch(function () {
            throw obsidianNetworkError(cfg);
        }).then(function (res) {
            if (res.status === 401 || res.status === 403) {
                throw new Error('API 키가 거부되었습니다 (HTTP ' + res.status + '). ' +
                                '플러그인 설정의 키를 다시 복사해 넣으세요.');
            }
            if (!res.ok && res.status !== 204) {
                return res.text().then(function (t) {
                    throw new Error('옵시디언 응답 오류 (HTTP ' + res.status + ')\n' + t.slice(0, 200));
                });
            }
            return true;
        });
    }

    /* 설정 화면의 "연결 테스트" — 쓰기 없이 상태·인증만 확인한다. */
    function testObsidian(patch) {
        var cfg = loadConfig().obsidian;
        if (patch) {
            for (var k in patch) {
                if (Object.prototype.hasOwnProperty.call(patch, k)) cfg[k] = patch[k];
            }
        }
        if (!cfg.baseUrl) return Promise.reject(new Error('주소를 입력하세요.'));
        if (!cfg.apiKey)  return Promise.reject(new Error('API 키를 입력하세요.'));

        var base = cfg.baseUrl.replace(/\/+$/, '');
        return fetch(base + '/vault/', {
            method: 'GET',
            mode: 'cors',
            headers: { 'Authorization': 'Bearer ' + cfg.apiKey }
        }).catch(function () {
            throw obsidianNetworkError(cfg);
        }).then(function (res) {
            if (res.status === 401 || res.status === 403) {
                throw new Error('API 키가 거부되었습니다 (HTTP ' + res.status + ').');
            }
            if (!res.ok) throw new Error('옵시디언 응답 오류 (HTTP ' + res.status + ')');
            return res.json();
        }).then(function (data) {
            return { files: (data && data.files) ? data.files.length : 0 };
        });
    }

    /* =========================================================
       공통 UI 헬퍼
       ========================================================= */
    function toast(msg, kind) {
        var wrap = document.querySelector('.toast-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.className = 'toast-wrap';
            document.body.appendChild(wrap);
        }
        var t = document.createElement('div');
        t.className = 'toast' + (kind ? ' ' + kind : '');
        t.textContent = msg;
        wrap.appendChild(t);
        setTimeout(function () {
            t.style.opacity = '0';
            t.style.transform = 'translateY(8px)';
            setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
        }, 2600);
    }

    /* 모달 열고/닫기 — 전역 규칙(우측 상단 X + 하단 버튼 + 바깥 클릭 + ESC) */
    function bindModal(backdropId, opts) {
        var back = document.getElementById(backdropId);
        if (!back) return null;
        opts = opts || {};
        function close() {
            back.classList.remove('show');
            if (opts.onClose) opts.onClose();
        }
        function open() {
            back.classList.add('show');
            if (opts.onOpen) opts.onOpen();
        }
        back.addEventListener('click', function (e) { if (e.target === back) close(); });
        var x = back.querySelector('.modal-close');
        if (x) x.addEventListener('click', close);
        Array.prototype.forEach.call(back.querySelectorAll('[data-close]'), function (b) {
            b.addEventListener('click', close);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && back.classList.contains('show')) close();
        });
        return { open: open, close: close, el: back };
    }

    /* 상단 진행 단계 표시 */
    function renderSteps(el, current) {
        if (!el) return;
        var names = ['1차 입력', '1차 분석', '2차 입력', '2차 분석'];
        var html = [];
        names.forEach(function (n, idx) {
            var no = idx + 1;
            var cls = no < current ? 'done' : (no === current ? 'now' : '');
            if (idx) html.push('<span class="sep">›</span>');
            html.push('<span class="step ' + cls + '"><span class="n">' +
                      (no < current ? '✓' : no) + '</span>' + n + '</span>');
        });
        el.innerHTML = html.join('');
    }

    /* 라디오 pill 하이라이트 (:has 미지원 브라우저 대비) */
    function bindRadioPills(scope) {
        var root = scope || document;
        Array.prototype.forEach.call(root.querySelectorAll('.radio-pill input[type=radio]'), function (r) {
            r.addEventListener('change', function () { syncRadioPills(root, r.name); });
        });
        var names = {};
        Array.prototype.forEach.call(root.querySelectorAll('.radio-pill input[type=radio]'), function (r) {
            names[r.name] = 1;
        });
        Object.keys(names).forEach(function (n) { syncRadioPills(root, n); });
    }

    function syncRadioPills(root, name) {
        Array.prototype.forEach.call(root.querySelectorAll('.radio-pill input[name="' + name + '"]'), function (r) {
            var pill = r.closest('.radio-pill');
            if (pill) pill.classList.toggle('checked', r.checked);
        });
    }

    function qs(key) {
        var m = new RegExp('[?&]' + key + '=([^&]*)').exec(location.search);
        return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
    }

    /* =========================================================
       토큰 사용량 — 로컬 집계
       ---------------------------------------------------------
       원본 기록은 프록시가 구글 시트에 남긴다. 여기 집계는 화면 표시용이며,
       프록시가 없거나 시트 설정 전이어도 사용자가 자기 사용량을 볼 수 있게 한다.
       ========================================================= */
    var USAGE_KEY = 'np_career_usage';

    function dayKey(d) {
        d = d || new Date();
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function readUsage() {
        try {
            var o = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
            return (o && typeof o === 'object') ? o : {};
        } catch (e) { return {}; }
    }

    /* 사용자 × 날짜별로 누적한다. 시트와 같은 축으로 맞춰 대조가 되게 한다. */
    function recordUsage(res) {
        if (!res || res.mock || !res.usage) return null;
        var inp = res.usage.input_tokens || 0;
        var out = res.usage.output_tokens || 0;
        if (!inp && !out) return null;

        var all = readUsage();
        var owner = currentOwner();
        var day = dayKey();
        if (!all[owner]) all[owner] = {};
        var cur = all[owner][day] || { input: 0, output: 0, calls: 0 };
        cur.input += inp;
        cur.output += out;
        cur.calls += 1;
        all[owner][day] = cur;
        try { localStorage.setItem(USAGE_KEY, JSON.stringify(all)); } catch (e) {}
        return { input: inp, output: out, total: inp + out };
    }

    /* 현재 사용자의 오늘·전체 사용량 */
    function usageSummary() {
        var all = readUsage()[currentOwner()] || {};
        var today = all[dayKey()] || { input: 0, output: 0, calls: 0 };
        var tot = { input: 0, output: 0, calls: 0, days: 0 };
        Object.keys(all).forEach(function (d) {
            tot.input += all[d].input || 0;
            tot.output += all[d].output || 0;
            tot.calls += all[d].calls || 0;
            tot.days += 1;
        });
        return { today: today, total: tot };
    }

    function fmtNum(n) {
        return (n || 0).toLocaleString('ko-KR');
    }

    /* 보고서에 실제로 참고한 웹 출처를 보여준다.
       프롬프트가 요구하는 "출처 및 신뢰도" 표를 교사가 교차 확인할 수 있게 하는 장치다. */
    function renderSources(card, rep, round) {
        if (!card) return;
        var list = (rep && rep.sources) || [];
        var searches = (rep && rep.searches) || 0;
        /* 2차 분석은 "1차 조사를 반복하지 말라"가 프롬프트 원칙이라
           출처 0건이 정상이다. 1차와 같은 경고를 띄우면 오탐이 된다. */
        var second = (round === 2);

        if (rep && rep.mock) {
            card.style.display = 'none';
            return;
        }
        card.style.display = '';

        var head = card.querySelector('.src-head');
        var body = card.querySelector('.src-list');
        if (!body) return;

        if (!list.length) {
            if (head) {
                if (second) {
                    head.className = 'notice info src-head';
                    head.innerHTML = '<span class="ico">ℹ</span><span>' +
                        '출처 0건 — <b>2차 분석에서는 정상입니다.</b> ' +
                        '2차 프롬프트는 “1차에서 수행한 조사를 불필요하게 반복하지 말 것”을 원칙으로 하므로 ' +
                        '새 검색을 거의 하지 않습니다. 사실 확인이 필요하면 1차 보고서의 ' +
                        '“출처 및 신뢰도” 표를 보십시오.' +
                        '</span>';
                } else {
                    head.className = 'notice src-head';
                    head.innerHTML = '<span class="ico">⚠</span><span>' +
                        '<b>웹검색 흔적이 없습니다.</b> 프록시가 <code>web_search</code> 도구를 켜지 않았거나, ' +
                        '검색 결과를 <code>sources</code> 로 돌려주지 않는 구버전입니다. ' +
                        '이 상태의 보고서는 모델 기억에 의존하므로 “확인 불가”가 많거나 부정확할 수 있습니다.' +
                        '</span>';
                }
            }
            body.innerHTML = '';
            return;
        }

        if (head) {
            head.className = 'notice ok src-head';
            head.innerHTML = '<span class="ico">✓</span><span>웹검색 <b>' + searches + '회</b>로 ' +
                '<b>' + list.length + '건</b>의 출처를 참고했습니다. ' +
                '보고서의 “출처 및 신뢰도” 표와 대조해 확인하세요.</span>';
        }

        body.innerHTML = '';
        list.forEach(function (s) {
            var a = document.createElement('a');
            a.className = 'src-item';
            a.href = s.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';

            var t = document.createElement('span');
            t.className = 'src-title';
            t.textContent = s.title || s.url;

            var u = document.createElement('span');
            u.className = 'src-url';
            try { u.textContent = new URL(s.url).hostname; } catch (e) { u.textContent = s.url; }

            a.appendChild(t);
            a.appendChild(u);
            body.appendChild(a);
        });
    }

    /* =========================================================
       공통 크롬(상단바 + 연결 설정 모달) 주입
       모든 진로상담 페이지가 동일한 배지·설정을 쓰도록 한 곳에서 만든다.
       ========================================================= */
    var AI_LABEL = { ready: 'AI 연결됨', mock: 'AI 미설정 · 모의 모드', off: 'AI 미설정' };
    var AI_CLASS = { ready: 'on', mock: 'mock', off: 'off' };

    function mountChrome(opts) {
        opts = opts || {};
        var bar = document.getElementById('topbar');
        if (bar) {
            bar.innerHTML =
                '<a class="home-link" href="' + (opts.back || 'career.html') + '">← ' +
                    esc(opts.backLabel || '진로상담 홈') + '</a>' +
                (opts.showHome === false ? '' :
                    '<a class="home-link" href="home.html">🏠 로그인 홈</a>') +
                '<span class="spacer"></span>' +
                '<button type="button" class="badge" id="aiBadge" title="AI 연결 설정">' +
                    '<span class="dot"></span><span class="t">—</span></button>' +
                '<button type="button" class="badge" id="searchBadge" title="공식자료 웹검색 설정">' +
                    '<span class="dot"></span><span class="t">—</span></button>' +
                '<button type="button" class="badge todo" id="obsBadge" title="옵시디언 전송 — 추후 결정">' +
                    '<span class="dot"></span><span class="t">옵시디언 미연결</span></button>';
        }

        if (!document.getElementById('cfgModal')) {
            var wrap = document.createElement('div');
            wrap.innerHTML = settingsModalHtml();
            document.body.appendChild(wrap.firstElementChild);
        }

        var modal = bindModal('cfgModal', { onOpen: fillConfigForm });
        var aiBadge = document.getElementById('aiBadge');
        if (aiBadge && modal) aiBadge.addEventListener('click', modal.open);
        var obsBadge = document.getElementById('obsBadge');
        if (obsBadge && modal) obsBadge.addEventListener('click', modal.open);
        var searchBadge = document.getElementById('searchBadge');
        if (searchBadge && modal) searchBadge.addEventListener('click', modal.open);

        var saveBtn = document.getElementById('cfgSave');
        if (saveBtn) {
            saveBtn.addEventListener('click', function () {
                saveConfig({
                    endpoint: (document.getElementById('cfgEndpoint').value || '').trim(),
                    model: (document.getElementById('cfgModel').value || '').trim() || 'claude-haiku-4-5',
                    maxTokens1: parseInt(document.getElementById('cfgTok1').value, 10) || 12000,
                    maxTokens2: parseInt(document.getElementById('cfgTok2').value, 10) || 12000,
                    timeoutSec: parseInt(document.getElementById('cfgTimeout').value, 10) || 400,
                    allowMock: document.getElementById('cfgMock').checked,
                    webSearch: document.getElementById('cfgSearch').checked,
                    searchMaxUses: parseInt(document.getElementById('cfgSearchUses').value, 10) || 12,
                    officialOnly: document.getElementById('cfgOfficial').checked,
                    effort: document.getElementById('cfgEffort').value || 'low',
                    obsidian: {
                        enabled: document.getElementById('cfgObsOn').checked,
                        baseUrl: (document.getElementById('cfgObsUrl').value || '').trim(),
                        apiKey: (document.getElementById('cfgObsKey').value || '').trim(),
                        folder: (document.getElementById('cfgObsFolder').value || '').trim()
                    }
                });
                refreshBadges();
                if (modal) modal.close();
                toast('연결 설정을 저장했습니다.', 'ok');
                if (opts.onConfigSaved) opts.onConfigSaved();
            });
        }

        var obsTest = document.getElementById('cfgObsTest');
        if (obsTest) {
            obsTest.addEventListener('click', function () {
                var st = document.getElementById('cfgObsStatus');
                st.className = 'hint';
                st.textContent = '확인 중…';
                obsTest.disabled = true;
                testObsidian({
                    baseUrl: (document.getElementById('cfgObsUrl').value || '').trim(),
                    apiKey: (document.getElementById('cfgObsKey').value || '').trim(),
                    folder: (document.getElementById('cfgObsFolder').value || '').trim()
                }).then(function (r) {
                    st.className = 'hint ok';
                    st.textContent = '연결 성공 — 볼트 루트에 ' + r.files + '개 항목이 보입니다.';
                }).catch(function (e) {
                    st.className = 'hint error';
                    st.textContent = String(e.message || e).split('\n')[0];
                }).then(function () { obsTest.disabled = false; });
            });
        }

        refreshBadges();
        return modal;
    }

    function refreshBadges() {
        var st = aiStatus();
        var b = document.getElementById('aiBadge');
        if (b) {
            b.className = 'badge ' + AI_CLASS[st];
            b.querySelector('.t').textContent = AI_LABEL[st];
        }
        var o = document.getElementById('obsBadge');
        if (o) {
            var ok = obsidianReady();
            o.className = 'badge ' + (ok ? 'on' : 'todo');
            o.querySelector('.t').textContent = ok ? '옵시디언 연결됨' : '옵시디언 미연결';
        }
        var s = document.getElementById('searchBadge');
        if (s) {
            var c = loadConfig();
            if (!c.webSearch) {
                s.className = 'badge off';
                s.querySelector('.t').textContent = '웹검색 꺼짐';
            } else if (c.officialOnly) {
                s.className = 'badge on';
                s.querySelector('.t').textContent = '웹검색 · 공식자료만';
            } else {
                s.className = 'badge on';
                s.querySelector('.t').textContent = '웹검색 켜짐';
            }
        }
    }

    function fillConfigForm() {
        var c = loadConfig();
        var set = function (id, v) { var el = document.getElementById(id); if (el) el.value = v; };
        var check = function (id, v) { var el = document.getElementById(id); if (el) el.checked = !!v; };
        set('cfgEndpoint', c.endpoint);
        set('cfgModel', c.model);
        set('cfgTok1', c.maxTokens1);
        set('cfgTok2', c.maxTokens2);
        set('cfgTimeout', c.timeoutSec);
        check('cfgMock', c.allowMock);
        check('cfgSearch', c.webSearch);
        set('cfgSearchUses', c.searchMaxUses);
        check('cfgOfficial', c.officialOnly);
        set('cfgEffort', c.effort);
        set('cfgObsUrl', c.obsidian.baseUrl);
        set('cfgObsFolder', c.obsidian.folder);
        set('cfgObsKey', c.obsidian.apiKey);
        check('cfgObsOn', c.obsidian.enabled);
        var st = document.getElementById('cfgObsStatus');
        if (st) { st.className = 'hint'; st.textContent = ''; }
        var dom = document.getElementById('cfgDomains');
        if (dom) dom.textContent = OFFICIAL_DOMAINS.join(' · ');
    }

    function settingsModalHtml() {
        return '' +
        '<div class="modal-backdrop" id="cfgModal">' +
          '<div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="cfgTitle">' +
            '<button type="button" class="modal-close" aria-label="닫기">✕</button>' +
            '<h2 id="cfgTitle">연결 설정</h2>' +
            '<p class="desc">AI 호출 경로와 옵시디언 전송 설정입니다. 이 브라우저에만 저장됩니다.</p>' +
            '<div class="scroll-body">' +
              '<div class="seg" style="border-top:none;padding-top:0">' +
                '<div class="seg-title">① AI 호출 <span class="tag" style="font-size:10px;padding:2px 7px;border-radius:999px;background:rgba(99,102,241,.12);color:#4f46e5">필수</span></div>' +
                '<div class="seg-desc">careerTest 와 같은 방식입니다. API 키는 브라우저가 아니라 프록시(Apps Script 등)에 두고, 여기에는 프록시 주소만 넣습니다. ' +
                  '<b>API 키·프록시 주소는 추후 결정 사항</b>이라 비워 두면 모의 모드로 동작합니다.</div>' +
                '<div class="field"><label for="cfgEndpoint">프록시 URL</label>' +
                  '<div class="input-wrap"><input type="url" id="cfgEndpoint" placeholder="https://script.google.com/macros/s/.../exec  (추후 결정)"></div></div>' +
                '<div class="field"><label for="cfgModel">모델</label>' +
                  '<select id="cfgModel">' +
                    '<option value="claude-haiku-4-5">Haiku 4.5 — 빠르고 저렴 (기본)</option>' +
                    '<option value="claude-sonnet-5">Sonnet 5 — 지시 준수·리서치 품질 우수</option>' +
                    '<option value="claude-opus-5">Opus 5 — 최고 품질, 가장 느림</option>' +
                  '</select>' +
                  '<div class="hint">Haiku 는 <b>사고 깊이(effort) 설정을 받지 않습니다</b> — ' +
                    '아래 effort 는 Sonnet·Opus 에서만 적용됩니다.</div></div>' +
                '<div class="grid2">' +
                  '<div class="field"><label for="cfgTok1">1차 max_tokens</label>' +
                    '<div class="input-wrap"><input type="number" id="cfgTok1" min="1000" step="500"></div></div>' +
                  '<div class="field"><label for="cfgTok2">2차 max_tokens</label>' +
                    '<div class="input-wrap"><input type="number" id="cfgTok2" min="1000" step="500"></div></div>' +
                  '<div class="field full"><label for="cfgTimeout">응답 대기 상한 (초)</label>' +
                    '<div class="input-wrap"><input type="number" id="cfgTimeout" min="30" max="900" step="10"></div>' +
                    '<div class="hint">Apps Script 는 6분에 강제 종료됩니다. ' +
                      '이 시간이 지나면 화면이 스스로 멈춥니다 — 무한 대기를 막는 안전장치입니다.</div></div>' +
                '</div>' +
                '<label class="checkbox" style="margin-top:2px"><input type="checkbox" id="cfgMock">' +
                  '<span>프록시 미설정 시 <b>모의 응답</b>으로 흐름 확인 허용</span></label>' +
              '</div>' +
              '<div class="seg">' +
                '<div class="seg-title">② 공식자료 웹검색 ' +
                  '<span class="chip ok">권장</span></div>' +
                '<div class="seg-desc">진로상담 프롬프트는 커리어넷·KOSIS·어디가·Q-Net 같은 ' +
                  '<b>공식자료 확인</b>을 전제로 씌어 있습니다. 검색 없이 호출하면 “확인 불가”가 대량으로 나옵니다. ' +
                  '프록시가 Anthropic의 <b>서버사이드 web_search 도구</b>를 켜도록 지시합니다 — ' +
                  '별도 검색 API는 필요 없습니다. 참고 구현은 <code>tools/career_proxy.example.gs</code>.</div>' +
                '<label class="checkbox"><input type="checkbox" id="cfgSearch">' +
                  '<span><b>웹검색 사용</b> (끄면 모델 기억만으로 답합니다 — 권장하지 않음)</span></label>' +
                '<div class="grid2" style="margin-top:12px">' +
                  '<div class="field"><label for="cfgSearchUses">분석 1회당 최대 검색</label>' +
                    '<div class="input-wrap"><input type="number" id="cfgSearchUses" min="1" max="30" step="1"></div></div>' +
                  '<div class="field"><label for="cfgEffort">사고 깊이 (effort)</label>' +
                    '<select id="cfgEffort">' +
                      '<option value="low">low — 가장 빠름 (권장 시작점)</option>' +
                      '<option value="medium">medium</option>' +
                      '<option value="high">high — 느림</option>' +
                    '</select></div>' +
                '</div>' +
                '<div class="seg-desc" style="margin-top:-4px">⚠ 프록시가 Apps Script 라면 ' +
                  '<b>실행 한도(개인 계정 6분)</b>가 있습니다. effort 와 검색 횟수를 올리면 ' +
                  '한도를 넘겨 <b>응답 없이 매달립니다</b> — low 로 시작해 시간이 남을 때만 올리세요.</div>' +
                '<label class="checkbox"><input type="checkbox" id="cfgOfficial">' +
                  '<span><b>공식 기관 도메인만</b> 검색</span></label>' +
                '<div class="seg-desc" style="margin-top:8px">' +
                  '⚠ 켜면 <b>대학 입학처·학과 홈페이지가 막힙니다</b>(학교마다 도메인이 다름). ' +
                  '대학 정보·입시결과가 필요한 고3 상담에서는 꺼 두세요.<br>' +
                  '<span class="mono" id="cfgDomains" style="font-size:10.5px;word-break:break-all"></span></div>' +
              '</div>' +
              '<div class="seg">' +
                '<div class="seg-title">③ 옵시디언 전송 ' +
                  '<span class="chip">선택</span></div>' +
                '<div class="seg-desc">Obsidian <b>Local REST API</b> 플러그인으로 볼트에 바로 씁니다. ' +
                  '플러그인 설정에서 <b>비암호화 HTTP(27123)</b> 를 켜고 API 키를 복사해 넣으세요 — ' +
                  'HTTPS(27124)는 자체서명 인증서라 브라우저가 막습니다.<br>' +
                  '⚠ API 키는 <b>이 브라우저에만</b> 저장됩니다. 공용 PC 에서는 쓰지 마세요.</div>' +
                '<label class="checkbox"><input type="checkbox" id="cfgObsOn">' +
                  '<span><b>옵시디언 전송 사용</b></span></label>' +
                '<div class="field" style="margin-top:12px"><label for="cfgObsUrl">Local REST API 주소</label>' +
                  '<div class="input-wrap"><input type="text" id="cfgObsUrl" placeholder="http://127.0.0.1:27123"></div></div>' +
                '<div class="field"><label for="cfgObsFolder">볼트 폴더</label>' +
                  '<div class="input-wrap"><input type="text" id="cfgObsFolder" placeholder="진로상담"></div></div>' +
                '<div class="field"><label for="cfgObsKey">API 키</label>' +
                  '<div class="input-wrap"><input type="password" id="cfgObsKey" placeholder="플러그인 설정에서 복사"></div></div>' +
                '<button type="button" class="btn btn-ghost" id="cfgObsTest" ' +
                  'style="width:auto;padding:9px 18px">연결 테스트</button>' +
                '<div class="hint" id="cfgObsStatus" style="margin-top:8px"></div>' +
                '<div class="seg-desc" style="margin-top:8px">진단이 더 필요하면 ' +
                  '<a href="tools/obsidian-check.html" target="_blank" rel="noopener">연결 실측 도구</a> 를 쓰세요.</div>' +
              '</div>' +
            '</div>' +
            '<div class="modal-actions">' +
              '<button type="button" class="btn btn-ghost" data-close>취소</button>' +
              '<button type="button" class="btn btn-primary" id="cfgSave">저장</button>' +
            '</div>' +
          '</div>' +
        '</div>';
    }

    /* =========================================================
       공개 API
       ========================================================= */
    g.Career = {
        /* 설정 */
        loadConfig: loadConfig,
        saveConfig: saveConfig,
        aiStatus: aiStatus,
        obsidianReady: obsidianReady,
        OBSIDIAN_PENDING_MSG: OBSIDIAN_PENDING_MSG,

        /* 저장소 */
        listCases: listCases,
        getCase: getCase,
        createCase: createCase,
        updateCase: updateCase,
        deleteCase: deleteCase,
        currentOwner: currentOwner,

        /* 입력 정의 · 보조 */
        CHOICES: CHOICES,
        entryYearFor: entryYearFor,
        bindQuickPick: bindQuickPick,
        fillSelect: fillSelect,
        FIELDS_1: FIELDS_1,
        FIELDS_2_EXP: FIELDS_2_EXP,
        FIELDS_2_SCHOOL: FIELDS_2_SCHOOL,

        /* 프롬프트 */
        buildUserMessage1: buildUserMessage1,
        buildUserMessage2: buildUserMessage2,

        /* AI */
        callAI: callAI,

        /* 출력 */
        mdToHtml: mdToHtml,
        withFrontMatter: withFrontMatter,
        fileName: fileName,
        downloadMd: downloadMd,
        sendToObsidian: sendToObsidian,
        testObsidian: testObsidian,

        /* UI */
        toast: toast,
        bindModal: bindModal,
        mountChrome: mountChrome,
        refreshBadges: refreshBadges,
        renderSources: renderSources,
        OFFICIAL_DOMAINS: OFFICIAL_DOMAINS,
        EXPECTED_PROXY_VERSION: EXPECTED_PROXY_VERSION,
        recordUsage: recordUsage,
        usageSummary: usageSummary,
        fmtNum: fmtNum,
        renderSteps: renderSteps,
        bindRadioPills: bindRadioPills,
        fmtDateTime: fmtDateTime,
        qs: qs,
        esc: esc
    };
})(window);
