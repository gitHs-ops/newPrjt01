# 画面を追加するときに1回：既存の画面設計書の画面シートを読み、補足入力\<画面ID>.xlsx に移す。図は fixed\ に取り出す。
# シートを上から部品（構成）に分けて並びをそのまま残す。項目の区分・必須・初期値・桁数・形式は、画面から自動で決まる値
# （capture.py の結果＋rules.py）と同じなら空欄にする（違うときだけ値を残す）。capture の結果が無ければ全部残す
#   python migrate.py SC-PUR-01 [設計書.xlsx]
#   python migrate.py 共通 [設計書.xlsx]   … 目次・業務フロー・変更点を 補足入力\_共通.xlsx に移す（画面シートの補足入力を先に）
import json, re, sys, zipfile
import openpyxl
from sdgen import cfg, book, rules, front, menu
from sdgen.sheet import AUTO_COLS, s, parse, drawing_of, pictures

sys.stdout.reconfigure(encoding='utf-8')


def images(src, sc, d):
    """シートの図を fixed\\ に取り出し、図の上にある部品（ラベル）に付ける。ラベルの無い図はラベルなしの図として足す"""
    z = zipfile.ZipFile(src); pics = pictures(z, sc)
    if not pics: return
    cfg.FIXED.mkdir(exist_ok=True)
    blk = d['構成']; figs = {f['図']: f for f in d['図']}; extra = []
    for k, (row, name, wpt, to) in enumerate(pics, 1):
        before = [b for b in blk if b['_row'] <= row and b['種類'] != '空行']; owner = before[-1] if before else None
        nxt = next((b for b in blk if b['_row'] > (owner['_row'] if owner else 0)), None)
        if nxt and nxt['種類'] == '空行': nxt['文字'] = max(1, int(nxt['文字']) - (to - row + 1))   # 図が占める行は作るときに図の高さで空ける
        fn = f'{sc}_図{k}.{name.rsplit(".", 1)[-1]}'; (cfg.FIXED / fn).write_bytes(z.read(f'xl/media/{name}'))
        f = figs.get(owner['順']) if owner and owner['種類'] == '図' else None
        if f and not f['画像']: f.update({'画像': f'fixed:{fn}', '幅pt': wpt})
        else: extra.append((owner['順'] if owner else 0, row, {'ラベル': '', '画像': f'fixed:{fn}', '幅pt': wpt}))
    for after, row, f in sorted(extra, key=lambda t: (t[0], t[1]), reverse=True):   # ラベルの無い図を差し込む（同じ位置は後ろから）
        pos = next((i for i, b in enumerate(blk) if b['順'] == after), -1) + 1
        blk.insert(pos, {'順': 0, '種類': '図', '区画ID': '', '文字': '', '見出し1': '', '見出し2': '', '_row': row, '_fig': f})
    renum(d)


def renum(d):
    """構成の「順」を振り直し、表・図の参照を合わせる"""
    old = {}
    for i, b in enumerate(d['構成'], 1):
        if b['順']: old[b['順']] = i
        b['順'] = i
    for t in d['表']: t['表'] = old[t['表']]
    for f in d['図']: f['図'] = old[f['図']]
    for b in d['構成']:
        if '_fig' in b: f = b.pop('_fig'); f['図'] = b['順']; d['図'].append(f)
    d['図'].sort(key=lambda f: f['図'])


def arrows(src, sc, d):
    """矢印（コネクタ）を図の中の位置（0〜1）として図シートに書く（Excel で開いて位置を読む）"""
    z = zipfile.ZipFile(src); dr = drawing_of(z, sc)
    if not dr or 'cxnSp' not in z.read(f'xl/drawings/{dr}').decode(): return
    import win32com.client as w
    xl = w.DispatchEx('Excel.Application'); xl.Visible = False; xl.DisplayAlerts = False
    try:
        wb = xl.Workbooks.Open(str(src), ReadOnly=True); ws = wb.Worksheets(sc)
        cons = [x for x in ws.Shapes if x.Connector]
        figs = sorted([x for x in ws.Shapes if x.Type == 13], key=lambda x: x.Top)
        order = [f for f in sorted(d['図'], key=lambda f: f['図']) if f['画像']]
        for x in cons:
            x0, y0, x1, y1 = x.Left, x.Top, x.Left + x.Width, x.Top + x.Height
            if x.HorizontalFlip: x0, x1 = x1, x0
            if x.VerticalFlip: y0, y1 = y1, y0
            def at(px, py):
                for k, p in enumerate(figs, 1):
                    if p.Left - 5 <= px <= p.Left + p.Width + 5 and p.Top - 5 <= py <= p.Top + p.Height + 30: return k, (px - p.Left) / p.Width, (py - p.Top) / p.Height
            a, b = at(x0, y0), at(x1, y1)
            if not (a and b) or a[0] > len(order): print('  矢印の位置が図に掛からない', x.Name); continue
            order[a[0] - 1].update({'矢印の終点': b[0], '起点x': round(a[1], 3), '起点y': round(a[2], 3), '終点x': round(b[1], 3), '終点y': round(b[2], 3)})
        wb.Close(False)
    finally:
        xl.Quit()


def norm(t):
    return re.sub(r'[\s.．]', '', str(t or ''))


def match_items(d, sc):
    """既存の項目と画面の項目を対応させ、キーを入れる。自動の値と同じ列は空欄にする"""
    f = cfg.WORK / 'capture' / f'{sc}.json'
    if not f.exists(): print('  capture の結果なし（項目の値はすべて残す）'); return {}
    cap = json.loads(f.read_text(encoding='utf-8')); dom = {}
    for v in cap['views']:
        for a in v['areas']: dom.setdefault((v['id'], a['area']), []).extend(a['items'])
    stat = {'一致': 0, '補足のみ': 0, '画面のみ': 0, '上書き': 0}
    for key, items in dom.items():
        rows = [r for r in d['項目'] if (r['区画ID'], r['エリア']) == key]; free = list(items)
        if not rows: print(f'  区画・エリアが既存に無い: {key}')
        for r in rows:
            hit = next((it for it in free if norm(it.get('label') or it.get('key')) == norm(r['項目名称'])), None)
            if hit: r['_it'] = hit; free.remove(hit)
        for r in rows:   # 名前で決まらないもの（ラベルのない検索条件など）は、ボタンかどうかが同じ項目と並び順で対応
            if '_it' in r: continue
            hit = next((it for it in free if (it.get('tag') == 'button') == (r.get('形式') == 'BUTTON')), None)
            if hit: r['_it'] = hit; free.remove(hit)
        stat['画面のみ'] += len(free)
        for it in free: print(f'  画面のみ {key[0]} {key[1]} {it.get("key")}')
    for r in d['項目']:
        it = r.pop('_it', None)
        if not it: stat['補足のみ'] += 1; continue
        stat['一致'] += 1; r['キー'] = it.get('key', ''); a = rules.auto(it, r)
        for c in AUTO_COLS:
            if s(a[c]) == s(r[c]): r[c] = ''
            else: stat['上書き'] += 1
    return stat


def main(sc, src=None):
    src = src or cfg.latest_doc()
    wb = openpyxl.load_workbook(src, data_only=True)
    d = parse(wb[sc], sc)
    images(src, sc, d); arrows(src, sc, d)
    stat = match_items(d, sc)
    for b in d['構成']: b.pop('_row', None)
    book.save(sc, d)
    kinds = {}
    for b in d['構成']: kinds[b['種類']] = kinds.get(b['種類'], 0) + 1
    print(f'{sc}: {src.name} → 補足入力\\{sc}.xlsx  構成 {kinds}  項目 {len(d["項目"])}  手順 {len(d["手順"])}  項目の対応 {stat}')


def common(src=None):
    src = src or cfg.latest_doc()
    wb = openpyxl.load_workbook(src, read_only=True, data_only=True); d = {k: [] for k in book.COMMON}
    toc = {r['シート名']: r for r in front.read_toc(wb['目次'])}
    for name in wb.sheetnames:   # 並び＝設計書のシートの並び
        if name.startswith('SC-'): d['目次'].append({**toc.get(name, {}), 'シート名': name, '載せる': '○' if name in toc else ''})
    ws = wb['目次']; d['文'] += [{'シート': '目次', '位置': '題', '文字': s(ws['A1'].value)}, {'シート': '目次', '位置': '説明', '文字': re.sub(r'全 \d+ シート', '全 {n} シート', s(ws['A2'].value))}]
    ws, at = front.sheet_in_docs('業務フロー', src, wb); rows, note = front.read_flow(ws)
    if at != src: print(f'  業務フロー：{src.name} に無いため {at.name} から')
    names = {sc: menu.screen_name(book.load(sc)) for sc in book.screens()}
    for r in rows:   # 画面名から作れる表記は空欄にする（画面名に合わせて変わる）
        if r['新システムの画面'] == front.auto_screen(r['画面ID'], names): r['新システムの画面'] = ''
    d['業務フロー'] = rows
    d['文'] += [{'シート': '業務フロー', '位置': k, '文字': v} for k, v in (('題', s(ws['A1'].value)), ('説明', s(ws['A2'].value)), ('注', note))]
    for name in wb.sheetnames:
        m = re.fullmatch(r'(V\d+)変更点', name)
        if not m: continue
        ws = wb[name]; d['変更点'] += front.read_changes(ws, m[1])
        d['文'] += [{'シート': name, '位置': '題', '文字': s(ws['A1'].value)}, {'シート': name, '位置': '説明', '文字': s(ws['A2'].value)}]
    book.save_common(d)
    auto = sum(1 for r in rows if not r['新システムの画面'])
    print(f'共通: {src.name} → 補足入力\\_共通.xlsx 目次 {len(d["目次"])}（載せる {len(toc)}）  業務フロー {len(rows)}（画面の表記を自動 {auto}）  変更点 {len(d["変更点"])}')


if __name__ == '__main__':
    src = cfg.Path(sys.argv[2]) if len(sys.argv) > 2 else None
    common(src) if sys.argv[1] == '共通' else main(sys.argv[1], src)
