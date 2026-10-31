# 1回だけ：既存の画面設計書（V15 など）の画面シートを読み、補足入力.xlsx に移す。図は fixed\ に取り出す。
# 項目の区分・必須・初期値・桁数・形式は、画面から自動で決まる値（capture.py の結果＋rules.py）と同じなら空欄にする（違うときだけ値を残す）
#   python migrate.py SC-PUR-01 [設計書.xlsx]
import json, re, sys, zipfile
import openpyxl
from sdgen import cfg, book, rules

sys.stdout.reconfigure(encoding='utf-8')
AUTO_COLS = ['区分', '必須', '初期値', '桁数', '形式']


def s(v):
    return '' if v is None else (str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)).strip()


def parse(ws, sc):
    d = {k: [] for k in book.SHEETS}
    mode, view, area, order = None, sc, '', {'画面': 0, '図': 0, '構成': 0}
    rows = list(ws.iter_rows(values_only=True))
    for i, r in enumerate(rows, 1):
        a = s(r[0]) if r else ''
        cells = [s(x) for x in r[:11]] + [''] * (11 - len(r[:11]))
        if i == 4 and a.startswith('画面仕様'):
            d['画面'].append({'画面ID': sc, '順': 0, '項目': '_見出し', '内容': a}); continue
        if a.startswith('■ この画面の基本情報'): mode = 'kv'; continue
        if a.startswith('■ 画面図'): mode = 'fig'; continue
        if a.startswith('■ 画面の構成'): mode = 'kv2'; continue
        if a.startswith('■ 業務ルール'): mode = 'rule'; continue
        if a.startswith('■ Excel 出力イメージ'): mode = 'rep'; continue
        if a.startswith('■ 表示区分の内訳'): mode = None; continue
        if a.startswith('■ 画面項目'): mode = 'items'; continue
        m = re.match(r'【画面項目】(\S+?)（(.+?)）（表示', a)
        if m:
            view = m[1]; d['区画'].append({'画面ID': sc, '区画ID': view, '名称': m[2], 'メニュー名': ''}); mode = None; continue
        m = re.match(r'【操作手順】(\S+)\s*(.*?)（(.+)）$', a)
        if m:
            view = m[1]; mode = 'step'
            for x in d['区画']:
                if x['区画ID'] == view: x['メニュー名'] = m[2]
            continue
        if mode == 'kv':
            if a in ('項目',) and cells[1] == '内容': continue
            if not a and not cells[1]:
                if d['画面'] and d['画面'][-1]['項目'] != '': order['画面'] += 1; d['画面'].append({'画面ID': sc, '順': order['画面'], '項目': '', '内容': ''})
                continue
            order['画面'] += 1; d['画面'].append({'画面ID': sc, '順': order['画面'], '項目': a, '内容': cells[1]})
        elif mode == 'fig' and a.startswith('〔'):
            order['図'] += 1; d['図'].append({'画面ID': sc, '順': order['図'], 'ラベル': a, '画像': '', '幅pt': '', '_row': i})
        elif mode == 'kv2':
            if a == '確認項目' or not a: continue
            order['構成'] += 1; d['構成'].append({'画面ID': sc, '順': order['構成'], '確認項目': a, '内容': cells[1]})
        elif mode == 'items':
            if a == 'Seq': continue
            if a.startswith('凡例'): mode = None; continue
            if a.startswith('〔'): area = a; continue
            if re.fullmatch(r'\d+', a) and cells[1]:
                row = {'画面ID': sc, '区画ID': view, 'エリア': area, 'キー': '', '項目名称': cells[1]}
                for k, c in zip(['区分', '必須', '初期値', '桁数', '少数', '形式', '参照元テーブル', '参照元項目', '備考'], cells[2:11]): row[k] = c
                d['項目'].append(row)
        elif mode == 'step':
            if a == '手順': continue
            if a and (re.fullmatch(r'\d+', a) or a == '—'):
                d['手順'].append({'画面ID': sc, '区画ID': view, '手順': a, '利用者の操作': cells[1], '内容': cells[2], '画面の反応': cells[5], '備考': cells[9]})
        elif mode == 'rule':
            if a == 'No' or not a: continue
            d['ルール'].append({'画面ID': sc, 'No': a, '内容': cells[1]})
        elif mode == 'rep':
            if a.startswith('〔'): d['帳票'].append({'画面ID': sc, '説明': '', 'ラベル': a, '画像': '', '幅pt': '', '_row': i})
            elif a and not d['帳票']: d.setdefault('_rep_desc', a)
    if d['帳票'] and d.get('_rep_desc'): d['帳票'][0]['説明'] = d.pop('_rep_desc')
    d.pop('_rep_desc', None)
    return d


def norm(t):
    return re.sub(r'[\s.．]', '', str(t or ''))


def match_items(d, cap):
    """V15 の項目と画面の項目を対応させ、キーを入れる。自動の値と同じ列は空欄にする"""
    dom = {}
    for v in cap['views']:
        for a in v['areas']: dom[(v['id'], a['area'])] = a['items']
    stat = {'一致': 0, '補足のみ': 0, '画面のみ': 0, '上書き': 0}
    for key, items in dom.items():
        rows = [r for r in d['項目'] if (r['区画ID'], r['エリア']) == key]
        free = list(items)
        for r in rows:   # 名前で対応
            hit = next((it for it in free if norm(it.get('label') or it.get('key')) == norm(r['項目名称'])), None)
            if hit: r['_it'] = hit; free.remove(hit)
        for r in rows:   # 名前で決まらないもの（ラベルのない検索条件など）は、ボタンかどうかが同じ項目と並び順で対応
            if '_it' in r: continue
            btn = r.get('形式') == 'BUTTON'
            hit = next((it for it in free if (it.get('tag') == 'button') == btn), None)
            if hit: r['_it'] = hit; free.remove(hit)
        stat['画面のみ'] += len(free)
        for it in free: print(f'  画面のみ {key[0]} {key[1]} {it.get("key")}')
    for r in d['項目']:
        it = r.pop('_it', None)
        if not it:
            stat['補足のみ'] += 1; print(f'  補足のみ {r["区画ID"]} {r["エリア"]} {r["項目名称"]}'); continue
        stat['一致'] += 1; r['キー'] = it.get('key', '')
        a = rules.auto(it, r)
        for c in AUTO_COLS:
            if s(a[c]) == s(r[c]): r[c] = ''
            else: stat['上書き'] += 1
    return stat


def images(src, sc, d):
    """画面シートの図を fixed\\ に取り出し、図・帳票シートの「画像」に入れる（画面図は図の上にあるラベルに対応）"""
    z = zipfile.ZipFile(src)
    wbx = z.read('xl/workbook.xml').decode(); rels = z.read('xl/_rels/workbook.xml.rels').decode()
    rid = re.search(r'<sheet [^>]*name="%s"[^>]*r:id="(rId\d+)"' % re.escape(sc), wbx)[1]
    target = re.search(r'Id="%s"[^>]*Target="([^"]+)"' % rid, rels) or re.search(r'Target="([^"]+)"[^>]*Id="%s"' % rid, rels)
    sheet = 'xl/' + target[1].replace('/xl/', '').lstrip('/')
    srel = sheet.replace('worksheets/', 'worksheets/_rels/') + '.rels'
    drawing = re.search(r'Target="\.\./drawings/([^"]+)"', z.read(srel).decode())[1]
    dx = z.read(f'xl/drawings/{drawing}').decode(); drel = z.read(f'xl/drawings/_rels/{drawing}.rels').decode()
    media = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="\.\./media/([^"]+)"', drel)) or {b: a for a, b in re.findall(r'Target="\.\./media/([^"]+)"[^>]*Id="(rId\d+)"', drel)}
    pics = []
    for m in re.finditer(r'<xdr:twoCellAnchor[^>]*>(.*?)</xdr:twoCellAnchor>', dx, re.S):
        b = m[1]; e = re.search(r'r:embed="(rId\d+)"', b)
        if not e: continue
        row = int(re.search(r'<xdr:from>.*?<xdr:row>(\d+)</xdr:row>', b, re.S)[1]) + 1
        cx = int(re.search(r'<a:ext cx="(\d+)"', b)[1]); pics.append((row, media[e[1]], round(cx / 12700, 1)))
    cfg.FIXED.mkdir(exist_ok=True)
    labels = sorted([(x['_row'], x) for x in d['図'] + d['帳票']], key=lambda t: t[0])
    for row, name, wpt in sorted(pics):
        owner = [x for r, x in labels if r < row]
        if not owner: continue
        x = owner[-1]; ext = name.rsplit('.', 1)[-1]; fn = f'{sc}_{"図" if x in d["図"] else "帳票"}{x.get("順", 1)}.{ext}'
        (cfg.FIXED / fn).write_bytes(z.read(f'xl/media/{name}')); x['画像'] = f'fixed:{fn}'; x['幅pt'] = wpt
    for x in d['図'] + d['帳票']: x.pop('_row', None)


def arrows(src, sc, d):
    """矢印（コネクタ）を図の中の位置（0〜1）として図シートに書く（Excel で開いて位置を読む）"""
    import win32com.client as w
    xl = w.DispatchEx('Excel.Application'); xl.Visible = False; xl.DisplayAlerts = False
    try:
        wb = xl.Workbooks.Open(str(src), ReadOnly=True); ws = wb.Worksheets(sc)
        pics = [x for x in ws.Shapes if x.Type == 13]; figs = sorted(pics, key=lambda x: x.Top)
        for x in ws.Shapes:
            if not x.Connector: continue
            x0, y0, x1, y1 = x.Left, x.Top, x.Left + x.Width, x.Top + x.Height
            if x.HorizontalFlip: x0, x1 = x1, x0
            if x.VerticalFlip: y0, y1 = y1, y0
            def at(px, py):
                for n, p in enumerate(figs, 1):
                    if p.Left - 5 <= px <= p.Left + p.Width + 5 and p.Top - 5 <= py <= p.Top + p.Height + 30: return n, (px - p.Left) / p.Width, (py - p.Top) / p.Height
                return None
            a, b = at(x0, y0), at(x1, y1)
            if not (a and b): print('  矢印の位置が図に掛からない', x.Name); continue
            src_fig = next((f for f in d['図'] if f['順'] == a[0]), None)
            if src_fig: src_fig.update({'矢印の終点': b[0], '起点x': round(a[1], 3), '起点y': round(a[2], 3), '終点x': round(b[1], 3), '終点y': round(b[2], 3)})
        wb.Close(False)
    finally:
        xl.Quit()


def main(sc, src=None):
    src = src or cfg.latest_doc()
    wb = openpyxl.load_workbook(src, data_only=True)
    d = parse(wb[sc], sc)
    cap = json.loads((cfg.WORK / 'capture' / f'{sc}.json').read_text(encoding='utf-8'))
    stat = match_items(d, cap)
    images(src, sc, d); arrows(src, sc, d)
    cur = book.load(cfg.SUPPLEMENT)
    for k in book.SHEETS: cur[k] = [r for r in cur.get(k, []) if r.get('画面ID') != sc] + d[k]
    book.save(cfg.SUPPLEMENT, cur)
    print(f'{sc}: {src.name} → {cfg.SUPPLEMENT.name}  ' + ' '.join(f'{k} {len(d[k])}' for k in book.SHEETS) + f'  項目の対応 {stat}')


if __name__ == '__main__':
    main(sys.argv[1], cfg.Path(sys.argv[2]) if len(sys.argv) > 2 else None)
