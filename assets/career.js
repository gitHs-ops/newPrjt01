/* newPrjt01 — 진로상담 공통 로직
   저장소 · 설정 · AI 호출 · 마크다운 렌더 · md 저장 · 옵시디언 전송(스텁)

   의존: assets/auth.js (세션), assets/career-prompts.js (프롬프트 원문)
   전역: window.Career
*/
(function (g) {
    'use strict';

    var CASES_KEY  = 'np_career_cases';
    var CONFIG_KEY = 'np_career_config';

    /* =========================================================
       설정
       ---------------------------------------------------------
       endpoint / apiKey / 옵시디언 접속정보는 모두 "추후 결정" 항목이다.
       비어 있으면 UI 가 미설정 상태를 표시하고, 분석은 모의 모드로만 돌아간다.
       ========================================================= */
    var DEFAULT_CONFIG = {
        /* --- AI 호출 (careerTest 의 GAS 프록시와 같은 방식) --- */
        endpoint: '',          /* 예: https://script.google.com/macros/s/.../exec  — 추후 결정 */
        model: 'claude-sonnet-5',
        maxTokens1: 8000,
        maxTokens2: 6000,
        allowMock: true,       /* 엔드포인트 미설정 시 모의 응답으로 흐름 검증 */

        /* --- Obsidian Local REST API (기능 표시만, 연결은 추후 결정) --- */
        obsidian: {
            enabled: false,    /* 추후 결정 전까지 false 고정 */
            baseUrl: 'https://127.0.0.1:27124',
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
            if (typeof raw.allowMock === 'boolean') c.allowMock = raw.allowMock;
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
                return { text: md, usage: null, mock: true };
            });
        }

        var payload = {
            system: opts.system || '',
            prompt: opts.user || '',
            max_tokens: opts.maxTokens || 4000,
            model: cfg.model
        };

        return fetch(endpoint, {
            method: 'POST',
            /* text/plain 이어야 GAS 웹앱에서 CORS preflight 없이 통과한다 */
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        }).catch(function () {
            /* fetch 자체가 실패 — 주소 오타 · 서버 다운 · CORS 차단 */
            throw new Error('프록시에 연결하지 못했습니다. 주소가 맞는지, 프록시가 응답하는지, ' +
                            'CORS 를 허용하는지 확인하세요. (' + endpoint + ')');
        }).then(function (res) {
            if (!res.ok) throw new Error('서버 오류 (HTTP ' + res.status + ')');
            return res.json();
        }).then(function (data) {
            if (data && data.error) throw new Error(String(data.error));
            var text = (data && data.text) ? String(data.text) : '';
            if (!text.trim()) throw new Error('응답이 비어 있습니다.');
            return { text: stripFence(text), usage: (data && data.usage) || null, mock: false };
        });
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
       Obsidian Local REST API — 기능 표시만 (연결은 추후 결정)
       ---------------------------------------------------------
       확정되면 아래 sendToObsidian 의 TODO 블록만 열면 된다.
         PUT {baseUrl}/vault/{folder}/{file}.md
         Authorization: Bearer {apiKey}
         Content-Type: text/markdown
       선행 확인 필요: 자체서명 인증서 신뢰, CORS 허용 여부, 볼트 경로 규칙
       ========================================================= */
    var OBSIDIAN_PENDING_MSG =
        '옵시디언 전송은 아직 연결되지 않았습니다.\n\n' +
        'Obsidian Local REST API 로 직접 HTTP 호출하는 방식으로 정해져 있으나, ' +
        '접속 주소·API 키·볼트 폴더 규칙이 추후 결정 사항으로 남아 있습니다.\n\n' +
        '지금은 md 파일로 저장한 뒤 볼트에 옮겨 주십시오.';

    function obsidianReady() {
        var c = loadConfig().obsidian;
        return !!(c.enabled && c.baseUrl && c.apiKey);
    }

    function sendToObsidian(name, content) {
        if (!obsidianReady()) {
            return Promise.reject(new Error(OBSIDIAN_PENDING_MSG));
        }
        /* TODO(추후 결정): 접속정보 확정 후 아래 주석을 해제하고 실제 PUT 을 수행한다.
        var c = loadConfig().obsidian;
        var path = encodeURI(c.folder ? (c.folder + '/' + name) : name);
        return fetch(c.baseUrl.replace(/\/+$/, '') + '/vault/' + path, {
            method: 'PUT',
            headers: {
                'Authorization': 'Bearer ' + c.apiKey,
                'Content-Type': 'text/markdown; charset=utf-8'
            },
            body: content
        }).then(function (res) {
            if (!res.ok) throw new Error('옵시디언 응답 오류 (HTTP ' + res.status + ')');
            return true;
        });
        */
        return Promise.reject(new Error(OBSIDIAN_PENDING_MSG));
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

        var saveBtn = document.getElementById('cfgSave');
        if (saveBtn) {
            saveBtn.addEventListener('click', function () {
                saveConfig({
                    endpoint: (document.getElementById('cfgEndpoint').value || '').trim(),
                    model: (document.getElementById('cfgModel').value || '').trim() || 'claude-sonnet-5',
                    maxTokens1: parseInt(document.getElementById('cfgTok1').value, 10) || 8000,
                    maxTokens2: parseInt(document.getElementById('cfgTok2').value, 10) || 6000,
                    allowMock: document.getElementById('cfgMock').checked
                });
                refreshBadges();
                if (modal) modal.close();
                toast('연결 설정을 저장했습니다.', 'ok');
                if (opts.onConfigSaved) opts.onConfigSaved();
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
    }

    function fillConfigForm() {
        var c = loadConfig();
        var set = function (id, v) { var el = document.getElementById(id); if (el) el.value = v; };
        set('cfgEndpoint', c.endpoint);
        set('cfgModel', c.model);
        set('cfgTok1', c.maxTokens1);
        set('cfgTok2', c.maxTokens2);
        var m = document.getElementById('cfgMock');
        if (m) m.checked = !!c.allowMock;
        set('cfgObsUrl', c.obsidian.baseUrl);
        set('cfgObsFolder', c.obsidian.folder);
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
                  '<div class="input-wrap"><input type="text" id="cfgModel" placeholder="claude-sonnet-5"></div></div>' +
                '<div class="grid2">' +
                  '<div class="field"><label for="cfgTok1">1차 max_tokens</label>' +
                    '<div class="input-wrap"><input type="number" id="cfgTok1" min="1000" step="500"></div></div>' +
                  '<div class="field"><label for="cfgTok2">2차 max_tokens</label>' +
                    '<div class="input-wrap"><input type="number" id="cfgTok2" min="1000" step="500"></div></div>' +
                '</div>' +
                '<label class="checkbox" style="margin-top:2px"><input type="checkbox" id="cfgMock">' +
                  '<span>프록시 미설정 시 <b>모의 응답</b>으로 흐름 확인 허용</span></label>' +
              '</div>' +
              '<div class="seg">' +
                '<div class="seg-title">② 옵시디언 전송 ' +
                  '<span class="chip wait">추후 결정</span></div>' +
                '<div class="seg-desc">Obsidian <b>Local REST API</b> 로 직접 HTTP 호출하는 방식으로 정해져 있습니다. ' +
                  '접속 주소·API 키·볼트 폴더 규칙이 확정되지 않아 <b>지금은 표시만</b> 하고 전송은 막아 두었습니다. ' +
                  '확정되면 <code>assets/career.js</code> 의 <code>sendToObsidian()</code> TODO 블록만 열면 됩니다.</div>' +
                '<div class="field"><label for="cfgObsUrl">Local REST API 주소</label>' +
                  '<div class="input-wrap"><input type="text" id="cfgObsUrl" value="https://127.0.0.1:27124" disabled></div></div>' +
                '<div class="field"><label for="cfgObsFolder">볼트 폴더</label>' +
                  '<div class="input-wrap"><input type="text" id="cfgObsFolder" value="진로상담" disabled></div></div>' +
                '<div class="field"><label for="cfgObsKey">API 키</label>' +
                  '<div class="input-wrap"><input type="password" id="cfgObsKey" placeholder="추후 결정" disabled></div></div>' +
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

        /* 입력 정의 */
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

        /* UI */
        toast: toast,
        bindModal: bindModal,
        mountChrome: mountChrome,
        refreshBadges: refreshBadges,
        renderSteps: renderSteps,
        bindRadioPills: bindRadioPills,
        fmtDateTime: fmtDateTime,
        qs: qs,
        esc: esc
    };
})(window);
