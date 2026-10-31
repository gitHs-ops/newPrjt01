# 1 画面の取り出し：screens\<画面ID>.json の手順でローカル検証サーバの画面を開き、区画ごとの項目（DOM）と画面図（PNG）を work\ に保存する
#   python capture.py            … 全画面
#   python capture.py SC-PUR-01  … 1画面
import json, sys
from playwright.sync_api import sync_playwright
from sdgen import cfg

sys.stdout.reconfigure(encoding='utf-8')

# 区画の中の項目を画面の並び順で取り出す（見えている要素だけ）
EXTRACT_JS = r"""
([rootSel, mode, opt]) => {
  const vis = e => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
  const txt = e => (e?.textContent || '').replace(/\s+/g, ' ').trim();
  const roots = [...document.querySelectorAll(rootSel)].filter(vis);
  const info = (el, label, key) => {
    const tag = el.tagName.toLowerCase(), sel = tag === 'select';
    return { key, label, tag, type: el.type || '', fp: el.classList.contains('fp-month') ? 'month' : el.classList.contains('fp-date') ? 'date' : '',
      required: !!el.closest('label.field.req') || !!el.required || !!el.closest('label.field.req'), maxlength: el.getAttribute('maxlength') || '',
      disabled: !!el.disabled, readonly: !!el.readOnly, value: sel ? '' : (el.value ?? ''), selected: sel ? (el.options[el.selectedIndex]?.text || '') : '',
      first: sel ? (el.options[0]?.text || '') : '', placeholder: el.placeholder || '', title: el.title || '', name: el.name || '', id: el.id || '',
      num: el.classList.contains('num') || el.type === 'number', list: el.getAttribute('list') || '', combo: el.classList.contains('combo-select') };
  };
  const control = box => box.querySelector('select, textarea, input:not(.combo-input)');
  const out = [];
  for (const root of roots) {
    if (mode === 'fields') {
      for (const lb of root.querySelectorAll('label.field')) { if (!vis(lb)) continue; const c = control(lb), name = txt(lb.querySelector('span')) || txt(lb); if (c) out.push(info(c, name, name)); }
    } else if (mode === 'controls') {
      const seen = new Set();
      for (const el of root.querySelectorAll('label.field, input:not(.combo-input), select, textarea, button, a.button')) {
        if (seen.has(el)) continue;
        const lb = el.tagName === 'LABEL' ? el : el.closest('label.field');
        if (lb && root.contains(lb)) { if (seen.has(lb) || !vis(lb)) continue; seen.add(lb); const c = control(lb); if (c) { seen.add(c); const name = txt(lb.querySelector('span')) || txt(lb).replace(txt(c), ''); out.push(info(c, name, name)); } continue; }
        if (el.tagName === 'BUTTON' || el.tagName === 'A') { if (opt.buttons && vis(el)) out.push({ key: txt(el), label: txt(el), tag: 'button', act: el.dataset.act || '' }); continue; }
        if (!vis(el) && !el.classList.contains('combo-select')) continue;
        out.push(info(el, '', el.name || el.id || el.title || el.placeholder));
      }
    } else if (mode === 'thead') {
      const t = root.tagName === 'TABLE' ? root : root.querySelector('table'), ths = [...t.querySelectorAll('thead th')], row = t.querySelector('tbody tr');
      ths.forEach((th, i) => { const cell = row?.cells[i], b = cell?.querySelector('button'); const name = txt(th) || txt(b);
        if (name) out.push({ key: name, label: name, tag: b && !txt(th) ? 'button' : 'td', num: th.classList.contains('num'), sample: txt(cell) }); });
    } else if (mode === 'linegrid') {
      const ths = [...root.querySelectorAll('thead th')], row = root.querySelector('tbody tr');
      ths.forEach((th, i) => { const cell = row?.cells[i], name = txt(th); if (!name || !cell) return; const c = control(cell);
        if (c) out.push(info(c, name, name)); else out.push({ key: name, label: name, tag: cell.classList.contains('line-no') ? 'lineno' : 'td', value: txt(cell) }); });
      const foot = txt(root.querySelector('tfoot')); if (/合計/.test(foot)) out.push({ key: '合計', label: '合計', tag: 'total', num: true, value: (foot.match(/合計\s*([\d,]+)/) || [])[1] || '' });
    } else if (mode === 'message') {
      out.push({ key: 'メッセージ', label: 'メッセージ', tag: 'message', value: txt(root.querySelector('p') || root) });
    }
  }
  return out;
}
"""


def run(only=None):
    screens = {f.stem: json.loads(f.read_text(encoding='utf-8')) for f in sorted(cfg.SCREENS.glob('SC-*.json'))}
    out_dir = cfg.WORK / 'capture'; (out_dir / 'png').mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=cfg.chromium(), args=['--lang=ja-JP'])
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='ja-JP', timezone_id='Asia/Tokyo', accept_downloads=True)
        p = ctx.new_page(); p.set_default_timeout(30000)
        errs = []; p.on('pageerror', lambda e: errs.append(str(e)))
        p.goto(cfg.BASE + '/login'); p.fill('input[name=loginId]', cfg.USER); p.fill('input[name=password]', cfg.password())
        with p.expect_navigation(): p.click('button[type=submit]')
        p.wait_for_timeout(1500)

        def idle(ms=600):
            p.wait_for_timeout(ms)
            try: p.wait_for_load_state('networkidle', timeout=5000)
            except Exception: pass
            p.wait_for_timeout(200)

        for sc, spec in screens.items():
            if only and sc != only: continue
            result = {'screen': sc, 'views': []}
            for v in spec['views']:
                view = {'id': v['id'], 'name': v['name'], 'areas': [], 'shots': []}
                for st in v['steps']:
                    if 'go' in st:
                        p.evaluate("() => location.hash = '#'"); p.wait_for_timeout(150); p.evaluate('h => location.hash = h', st['go']); idle()
                    elif st.get('search'):
                        s = p.locator('#content [data-search]:visible, #content [data-act=search]:visible').first
                        if s.count(): s.click(); idle(1200)
                    elif 'click' in st:
                        p.locator(st['click']).first.click(); idle()
                    elif 'fill' in st:
                        p.locator(st['fill'][0]).first.fill(st['fill'][1]); p.locator(st['fill'][0]).first.dispatch_event('input'); idle(200)
                    elif 'set' in st:   # 日付（flatpickr）など
                        p.evaluate("([s, v]) => { const e = document.querySelector(s); if (!e) return; e._flatpickr ? e._flatpickr.setDate(v, true) : (e.value = v); e.dispatchEvent(new Event('change', { bubbles: true })); }", st['set'])
                    elif 'extract' in st:
                        x = st['extract']; items = p.evaluate(EXTRACT_JS, [x['root'], x['mode'], {'buttons': x.get('buttons', False)}])
                        if not items: print(f'  ! {v["id"]} {x["area"]}: 項目が取れない（{x["root"]}）')
                        view['areas'].append({'area': x['area'], 'mode': x['mode'], 'items': items})
                    elif 'shot' in st:
                        x = st['shot']; w, h = x.get('viewport', [1440, 900]); p.set_viewport_size({'width': w, 'height': h}); idle(300)
                        f = out_dir / 'png' / f'{x["name"]}.png'
                        if 'el' in x: p.locator(x['el']).first.screenshot(path=str(f))
                        else: p.screenshot(path=str(f), clip=dict(zip(('x', 'y', 'width', 'height'), x['clip'])) if 'clip' in x else None)
                        view['shots'].append(x['name']); p.set_viewport_size({'width': 1440, 'height': 900})
                    elif 'download' in st:
                        x = st['download']
                        with p.expect_download() as d: p.click(x['click'])
                        d.value.save_as(str(out_dir / x['name'])); view['shots'].append(x['name'])
                    elif st.get('escape'):
                        p.keyboard.press('Escape'); idle(300)
                result['views'].append(view)
                print(f'{v["id"]}: ' + ' / '.join(f'{a["area"]} {len(a["items"])}' for a in view['areas']))
            (out_dir / f'{sc}.json').write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')
        b.close()
    if errs: print('画面のエラー:', errs)


if __name__ == '__main__':
    run(sys.argv[1] if len(sys.argv) > 1 else None)
