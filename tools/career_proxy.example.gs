/**
 * career_proxy.example.gs — 진로 계열 공용 AI 프록시 (참고 구현)
 * =============================================================================
 * 하나의 Apps Script 배포로 **두 앱을 함께** 받는다. API 키도 하나만 쓴다.
 *
 *   GET  ?prompt=...&max_tokens=...   → careerTest (기존 동작 그대로, HTML 출력)
 *   POST {system, prompt, ...}        → newPrjt01 진로상담 (md 출력 + 공식자료 웹검색)
 *
 * ── 왜 GET 하나로 합칠 수 없나 ────────────────────────────────────────────────
 *   careerTest 는 프롬프트를 URL 쿼리에 실어 보낸다. 진로상담의 1차 프롬프트는
 *   26KB 가 넘어 URL 인코딩하면 7만 자를 훌쩍 넘긴다 — URL 길이 한계로 원천 불가다.
 *   또 careerTest 의 system 프롬프트는 소스에 고정돼 있고 HTML 출력을 요구하는데,
 *   진로상담은 1차/2차 프롬프트 전문을 매번 실어 보내고 md 를 받아야 한다.
 *   그래서 GET(기존)은 건드리지 않고 POST 를 **추가**한다.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 기존 careerTest 프록시에 얹는 경우:
 *   1. 기존 Apps Script 프로젝트를 열고 이 파일 내용으로 교체한다
 *      (아래 doGet 은 기존 career_proxy.gs ver4.1 과 동작이 같다)
 *   2. 소스에 박혀 있던 API 키를 지우고 → 프로젝트 설정 → 스크립트 속성에
 *      ANTHROPIC_API_KEY 로 옮긴다. **소스에 키를 두면 안 된다**
 *   3. 배포 → 배포 관리 → 편집(연필) → 버전: 새 버전 → 배포
 *      ⚠ "새 배포"가 아니라 **"배포 관리 → 새 버전"** 이어야 /exec URL 이 유지되고
 *        careerTest 가 계속 돈다
 *   4. 같은 /exec URL 을 진로상담 화면의 [연결 설정]에 넣는다
 *
 * 새로 만드는 경우:
 *   script.google.com → 새 프로젝트 → 이 내용 붙여넣기 → 스크립트 속성에 키 →
 *   배포 → 새 배포 → 웹 앱 / 실행 계정: 나 / 액세스: 모든 사용자
 *
 * 왜 프록시를 두는가:
 *   - API 키가 브라우저에 노출되지 않는다
 *   - Anthropic API 는 브라우저에서 직접 부르면 CORS 로 막힌다
 *
 * 이 프록시가 해결하는 핵심 문제 — **공식자료 웹검색**:
 *   진로상담 프롬프트는 커리어넷·KOSIS·대학 입학처·Q-Net 등 공식자료 확인을 전제로 한다.
 *   검색 없이 호출하면 "확인 불가"만 잔뜩 나온다. 그래서 Anthropic 의 **서버사이드
 *   web_search 도구**를 켠다. 검색은 Anthropic 서버에서 실행되므로 별도 검색 API 가 필요 없다.
 *
 * ⚠ 키를 공유하면 두 앱의 사용량·요금·레이트리밋이 한 계정에 합산된다.
 *   진로상담 1회 분석은 웹검색까지 도니 careerTest 한 탭보다 훨씬 무겁다.
 * =============================================================================
 */

/* ----------------------------------------------------------------- 설정 */

var API_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';

/** 기본 모델. web_search_20260209(동적 필터링)은 Opus 5/4.8/4.7/4.6, Sonnet 5, Sonnet 4.6 에서 동작한다. */
var DEFAULT_MODEL = 'claude-opus-5';

/** 서버사이드 검색 루프가 10회에 도달하면 stop_reason=pause_turn 으로 끊긴다. 이어붙일 최대 횟수. */
var MAX_CONTINUATIONS = 4;

/** 응답 형식을 md 로 유지하기 위한 최소 지시. 본 프롬프트는 클라이언트가 system 으로 보낸다. */
var SYSTEM_SUFFIX = '\n\n---\n\n웹검색 도구를 사용할 수 있다면 위 "공식 정보 출처 제한" 절에 열거된 ' +
    '기관·자료를 우선 검색해 확인하라. 검색으로도 확인되지 않으면 추측하지 말고 ' +
    '"[확인 불가 — 최신 공식자료 조회 필요]" 로 표시하라.';

function apiKey_() {
  var k = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!k) throw new Error('스크립트 속성 ANTHROPIC_API_KEY 가 설정되지 않았습니다.');
  return k;
}

/* ----------------------------------------------------------------- 진입점 */

/* ---------------------------------------------- GET — careerTest (기존 동작) */

/**
 * careerTest 가 쓰던 경로. 동작을 바꾸지 말 것 —
 * career_advisor.html 이 PROXY_URL + '?prompt=...&max_tokens=...' 로 부른다.
 * system 프롬프트가 고정이고 HTML 을 출력한다. 웹검색은 쓰지 않는다.
 *
 * 프롬프트 없이 /exec 를 그냥 열면 상태 표시가 뜬다.
 */
var CAREERTEST_SYSTEM =
    '당신은 대한민국 청소년 진로 전문 컨설턴트입니다. ' +
    '학생[이름|학년|직업군|홀랜드유형|적성|가치관|약점] 형식의 정보와 과제를 받으면, ' +
    '한국 실정에 맞는 구체적인 진로 조언을 HTML 형식으로 제공하세요. ' +
    '<h4>, <ul>, <li>, <strong> 태그를 적극 활용하세요.';

var CAREERTEST_MODEL = 'claude-sonnet-5';

function doGet(e) {
  try {
    if (!e || !e.parameter || !e.parameter.prompt) {
      return json_({
        status: 'career proxy OK',
        get: 'careerTest (HTML)',
        post: 'newPrjt01 진로상담 (md + web_search)',
        model: DEFAULT_MODEL
      });
    }

    var maxTokens = parseInt(e.parameter.max_tokens, 10) || 1500;

    var res = UrlFetchApp.fetch(API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey_(),
        'anthropic-version': ANTHROPIC_VERSION
      },
      payload: JSON.stringify({
        model: CAREERTEST_MODEL,
        max_tokens: maxTokens,
        system: CAREERTEST_SYSTEM,
        messages: [{ role: 'user', content: e.parameter.prompt }]
      }),
      muteHttpExceptions: true
    });

    var data = JSON.parse(res.getContentText());
    var text = '';
    if (data.content) {
      for (var i = 0; i < data.content.length; i++) {
        if (data.content[i].type === 'text') text += data.content[i].text;
      }
    }

    return json_({
      text: text.replace(/^```html\s*/, '').replace(/```\s*$/, '').trim(),
      usage: data.usage || null,
      error: data.error ? data.error.message : null
    });

  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

/* ------------------------------------------- POST — newPrjt01 진로상담 */

/**
 * 본 요청. 클라이언트(assets/career.js)가 보내는 형태:
 *   POST <exec URL>
 *   Content-Type: text/plain;charset=utf-8      ← CORS preflight 회피용
 *   {
 *     "system": "<1차 또는 2차 프롬프트 전문>",
 *     "prompt": "<학생 입력 데이터>",
 *     "max_tokens": 8000,
 *     "model": "claude-opus-5",
 *     "web_search": true,
 *     "search_max_uses": 12,
 *     "allowed_domains": ["career.go.kr", "kosis.kr"]   // 선택 — 비우면 제한 없음
 *   }
 *
 * 응답:
 *   { "text": "...md...", "usage": {...}, "sources": [{title,url}], "searches": 3, "error": null }
 */
function doPost(e) {
  try {
    var req = {};
    if (e && e.postData && e.postData.contents) {
      req = JSON.parse(e.postData.contents);
    }
    if (!req.prompt) throw new Error('prompt 가 비어 있습니다.');

    var result = callClaude_(req);
    return json_(result);

  } catch (err) {
    return json_({ text: '', usage: null, sources: [], searches: 0, error: String(err && err.message || err) });
  }
}

/* ----------------------------------------------------------------- 호출 */

function callClaude_(req) {
  var model = req.model || DEFAULT_MODEL;
  var maxTokens = parseInt(req.max_tokens, 10) || 8000;
  var useSearch = req.web_search !== false;   // 기본 켬

  var tools = [];
  if (useSearch) {
    var search = { type: 'web_search_20260209', name: 'web_search' };

    var maxUses = parseInt(req.search_max_uses, 10);
    if (maxUses > 0) search.max_uses = maxUses;

    // 도메인 화이트리스트는 선택. 대학 입학처는 학교마다 도메인이 달라
    // 화이트리스트를 켜면 대학 정보 조회가 막힐 수 있다 — 필요할 때만 쓸 것.
    if (req.allowed_domains && req.allowed_domains.length) {
      search.allowed_domains = req.allowed_domains;
    }
    tools.push(search);

    // 검색으로 찾은 페이지 본문을 읽어야 기준연도·시행여부를 확인할 수 있다.
    tools.push({ type: 'web_fetch_20260209', name: 'web_fetch' });
  }

  var system = String(req.system || '');
  if (useSearch) system += SYSTEM_SUFFIX;

  var messages = [{ role: 'user', content: String(req.prompt) }];

  var text = '';
  var sources = [];
  var searches = 0;
  var usage = null;
  var stop = null;

  // 서버사이드 도구 루프가 pause_turn 으로 끊기면 이어서 재요청한다.
  // 이때 "계속하세요" 같은 사용자 메시지를 덧붙이면 안 된다 — 서버가 알아서 이어간다.
  for (var turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    var body = {
      model: model,
      max_tokens: maxTokens,
      system: system,
      messages: messages
    };
    if (tools.length) body.tools = tools;

    var res = UrlFetchApp.fetch(API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey_(),
        'anthropic-version': ANTHROPIC_VERSION
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });

    var code = res.getResponseCode();
    var data = JSON.parse(res.getContentText());

    if (code !== 200) {
      var msg = (data && data.error && data.error.message) ? data.error.message : ('HTTP ' + code);
      throw new Error('Anthropic API 오류: ' + msg);
    }
    if (data.error) throw new Error(String(data.error.message || data.error));

    usage = data.usage || usage;
    stop = data.stop_reason;

    var picked = harvest_(data.content || []);
    text += picked.text;
    searches += picked.searches;
    sources = sources.concat(picked.sources);

    if (stop !== 'pause_turn') break;

    // 이어달리기: 사용자 메시지 + 지금까지의 assistant 응답을 그대로 되돌려 보낸다.
    messages = [
      { role: 'user', content: String(req.prompt) },
      { role: 'assistant', content: data.content }
    ];
  }

  // Opus 5 는 안전 분류기가 요청을 거절하면 200 + stop_reason=refusal 로 돌아온다.
  if (stop === 'refusal') {
    throw new Error('모델이 요청을 거절했습니다(stop_reason=refusal). 입력 내용을 확인하세요.');
  }

  return {
    text: stripFence_(text),
    usage: usage,
    sources: dedupe_(sources),
    searches: searches,
    truncated: (stop === 'max_tokens'),
    error: null
  };
}

/* ----------------------------------------------------------------- 응답 파싱 */

/**
 * content 블록에서 본문 텍스트와 검색 출처를 뽑는다.
 * 서버 도구 오류는 예외가 아니라 200 응답 안에 온다 —
 * web_search_tool_result.content 가 성공이면 배열, 오류면 {error_code:...} 객체다.
 */
function harvest_(blocks) {
  var text = '';
  var sources = [];
  var searches = 0;

  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];

    if (b.type === 'text') {
      text += b.text;

    } else if (b.type === 'server_tool_use') {
      if (b.name === 'web_search') searches++;

    } else if (b.type === 'web_search_tool_result') {
      var c = b.content;
      if (Object.prototype.toString.call(c) === '[object Array]') {
        for (var j = 0; j < c.length; j++) {
          if (c[j] && c[j].url) sources.push({ title: c[j].title || c[j].url, url: c[j].url });
        }
      }
      // 오류 객체({error_code:...})면 출처가 없다. 본문에 반영되지 않으므로 조용히 넘어간다.

    } else if (b.type === 'web_fetch_tool_result') {
      var f = b.content;
      if (f && f.url) sources.push({ title: (f.document && f.document.title) || f.url, url: f.url });
    }
  }
  return { text: text, sources: sources, searches: searches };
}

function dedupe_(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var u = list[i].url;
    if (!u || seen[u]) continue;
    seen[u] = 1;
    out.push(list[i]);
  }
  return out;
}

function stripFence_(t) {
  return String(t)
    .replace(/^\s*```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/, '')
    .trim();
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ----------------------------------------------------------------- 점검용 */

/** Apps Script 편집기에서 직접 실행해 배포 전에 확인한다. */
function testProxy() {
  var out = callClaude_({
    system: '당신은 대한민국 진로교사를 돕는 리서치 어시스턴트다. 공식자료만 사용하고, ' +
            '확인되지 않으면 "[확인 불가]" 라고 표시하라. 답변은 md 로 작성하라.',
    prompt: '커리어넷에서 "반도체공학기술자" 직업정보가 현재 제공되는지 확인하고, ' +
            '확인된 사실만 3줄로 정리하라.',
    max_tokens: 2000,
    web_search: true,
    search_max_uses: 5
  });
  Logger.log('searches=%s sources=%s', out.searches, out.sources.length);
  Logger.log(out.text);
}
