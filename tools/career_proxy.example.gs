/**
 * career_proxy.example.gs — newPrjt01 진로상담 AI 프록시 (참고 구현)
 * =============================================================================
 * 이 파일은 **예시**다. 그대로 Google Apps Script 에 붙여 넣고 API 키만 채우면 동작한다.
 * 이 저장소에는 키를 절대 커밋하지 말 것 — 키는 Apps Script 의 스크립트 속성에만 둔다.
 *
 * 배포:
 *   1. script.google.com 에서 새 프로젝트 생성 후 이 파일 내용을 붙여넣는다
 *   2. 프로젝트 설정 → 스크립트 속성에 ANTHROPIC_API_KEY 추가
 *   3. 배포 → 새 배포 → 웹 앱 / 실행 계정: 나 / 액세스: 모든 사용자
 *   4. 발급된 /exec URL 을 진로상담 화면의 [연결 설정]에 넣는다
 *
 * 왜 프록시를 두는가:
 *   - API 키가 브라우저에 노출되지 않는다
 *   - Anthropic API 는 브라우저에서 직접 부르면 CORS 로 막힌다
 *
 * 이 프록시가 해결하는 핵심 문제 — **공식자료 웹검색**:
 *   진로상담 프롬프트는 커리어넷·KOSIS·대학 입학처·Q-Net 등 공식자료 확인을 전제로 한다.
 *   검색 없이 호출하면 "확인 불가"만 잔뜩 나온다. 그래서 Anthropic 의 **서버사이드
 *   web_search 도구**를 켠다. 검색은 Anthropic 서버에서 실행되므로 별도 검색 API 가 필요 없다.
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

/** 상태 확인용. 브라우저로 /exec 를 그냥 열면 이게 뜬다. */
function doGet(e) {
  return json_({
    status: 'newPrjt01 career proxy OK',
    model: DEFAULT_MODEL,
    web_search: true
  });
}

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
