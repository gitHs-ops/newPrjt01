# 画面を追加するときに1回：既存の画面設計書の画面シートを読み、補足入力\<画面ID>.xlsx に移す。図は fixed\ に取り出す。
# シートを上から部品（構成）に分けて並びをそのまま残す。項目の区分・必須・初期値・桁数・形式は、画面から自動で決まる値
# （capture.py の結果＋rules.py）と同じなら空欄にする（違うときだけ値を残す）。capture の結果が無ければ全部残す
#   python migrate.py SC-PUR-01 [設計書.xlsx]
import json, re, sys, zipfile
import openpyxl
from sdgen import cfg, book, rules

sys.stdout.reconfigure(encoding='utf-8')
AUTO_COLS = ['区分', '必須', '初期値', '桁数', '形式']
TABLE_HEADS = {('項目', '内容'), ('確認項目', '内容'), ('No', '内容')}


def s(v):
    if v is None: return ''
    if isinstance(v, float) and v.is_integer(): return str(int(v))
    if hasattr(v, 'strftime'): return v.strftime('%Y-%m-%d')
    return str(v).strip()


def parse(ws, sc):
    rows = [[s(x) for x in (list(r)[:11] + [None] * 11)[:11]] for r in ws.iter_rows(values_only=True)]
    d = {k: [] for k in book.SHEETS}
    blk = d['構成']

    def add(kind, row, **kw):
        b = {'順': len(blk) + 1, '種類': kind, '区画ID': '', '文字': '', '見出し1': '', '見出し2': '', '_row': row, **kw}; blk.append(b); return b

    def is_head(c):
        return c[0].startswith(('■', '【', '〔', '画面仕様', '凡例', '← 目次')) or c[0] == '顧客名'

    n = len(rows)

    def read_table(b, i, k):
        while i < n:
            x = rows[i]
            if not any(x) or is_head(x): break
            k += 1; d['表'].append({'表': b['順'], '順': k, '左': x[0], '右': next((v for v in x[1:] if v), '')}); i += 1   # 右の文は B 以外の列のこともある
        return i

    i, blank = 0, 0
    while i < n:
        c = rows[i]; a = c[0]; row = i + 1
        if not any(c): blank += 1; i += 1; continue
        if blank and blk: add('空行', row - blank, 文字=blank)
        blank = 0
        if a == '顧客名': add('表紙', row); i += 2; continue
        if a.startswith('← 目次'): add('戻る', row); i += 1; continue
        m = re.match(r'【画面項目】(\S+?)（', a)
        if m:   # 画面項目：見出し〜凡例 まで。区分の内訳・表は作り直すので、項目の行だけ取る
            view = m[1]; add('項目', row, 区画ID=view, 文字=re.sub(r'表示 \d+ 項目', '表示 {n} 項目', a)); area, inside = '', False; i += 1
            while i < n and not rows[i][0].startswith('凡例'):
                x = rows[i]
                if x[0].startswith('■ 画面項目'): inside = True
                elif inside and x[0].startswith('〔'): area = x[0]
                elif inside and re.fullmatch(r'\d+', x[0]) and x[1]:
                    r_ = {'区画ID': view, 'エリア': area, 'キー': '', '項目名称': x[1]}
                    for k, v in zip(['区分', '必須', '初期値', '桁数', '少数', '形式', '参照元テーブル', '参照元項目', '備考'], x[2:11]): r_[k] = v
                    d['項目'].append(r_)
                elif x[0].startswith(('【', '■ 業務', '■ 画面図')): break   # 凡例が無いシート
                i += 1
            if i < n and rows[i][0].startswith('凡例'): i += 1
            continue
        m = re.match(r'【操作手順】(\S+)', a)
        if m:
            view = m[1]; add('手順', row, 区画ID=view, 文字=a); i += 1
            while i < n and not any(rows[i]): i += 1   # 見出しと表の間の空行（作るときは1行あける）
            if i < n and rows[i][0] == '手順': i += 1
            while i < n and rows[i][0] and (re.fullmatch(r'\d+', rows[i][0]) or rows[i][0] in ('—', '-', '－')):
                x = rows[i]; d['手順'].append({'区画ID': view, '手順': x[0], '利用者の操作': x[1], '内容': x[2], '画面の反応': x[5], '備考': x[9]}); i += 1
            continue
        if (a, c[1]) in TABLE_HEADS:   # 2列の表（見出しの次の行から）
            b = add('表', row, 見出し1=a, 見出し2=c[1]); i = read_table(b, i + 1, 0); continue
        last = next((x for x in reversed(blk) if x['種類'] != '空行'), None)
        if last and last['種類'] == '表' and a and c[1] and not is_head(c):   # 空行をはさんで表が続く（空行は表の中の区切り）
            pos = blk.index(last); gap = sum(int(x['文字']) for x in blk[pos + 1:]); del blk[pos + 1:]
            k = max([t['順'] for t in d['表'] if t['表'] == last['順']] or [0])
            for _ in range(gap): k += 1; d['表'].append({'表': last['順'], '順': k, '左': '', '右': ''})
            i = read_table(last, i, k); continue
        if a.startswith('画面仕様') or a.startswith('【'): add('見出し大', row, 文字=a); i += 1; continue
        if a.startswith('■'): add('見出し中', row, 文字=a); i += 1; continue
        if a.startswith('〔'): b = add('図', row); d['図'].append({'図': b['順'], 'ラベル': a, '画像': '', '幅pt': ''}); i += 1; continue
        add('文', row, 文字=a); i += 1
    return d


def sheet_part(z, sc):
    wbx = z.read('xl/workbook.xml').decode(); rels = z.read('xl/_rels/workbook.xml.rels').decode()
    rid = re.search(r'<sheet [^>]*name="%s"[^>]*r:id="(rId\d+)"' % re.escape(sc), wbx)[1]
    target = re.search(r'Id="%s"[^>]*Target="([^"]+)"' % rid, rels) or re.search(r'Target="([^"]+)"[^>]*Id="%s"' % rid, rels)
    return 'xl/' + target[1].replace('/xl/', '').lstrip('/')


def drawing_of(z, sc):
    srel = sheet_part(z, sc).replace('worksheets/', 'worksheets/_rels/') + '.rels'
    m = re.search(r'Target="\.\./drawings/([^"]+)"', z.read(srel).decode()) if srel in z.namelist() else None
    return m[1] if m else None


def images(src, sc, d):
    """シートの図を fixed\\ に取り出し、図の上にある部品（ラベル）に付ける。ラベルの無い図はラベルなしの図として足す"""
    z = zipfile.ZipFile(src); dr = drawing_of(z, sc)
    if not dr: return
    dx = z.read(f'xl/drawings/{dr}').decode(); drel = z.read(f'xl/drawings/_rels/{dr}.rels').decode()
    media = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="\.\./media/([^"]+)"', drel)) or {b: a for a, b in re.findall(r'Target="\.\./media/([^"]+)"[^>]*Id="(rId\d+)"', drel)}
    pics = []
    for x in re.finditer(r'<xdr:(twoCellAnchor|oneCellAnchor)[^>]*>(.*?)</xdr:\1>', dx, re.S):
        e = re.search(r'r:embed="(rId\d+)"', x[2])
        if not e: continue
        row = int(re.search(r'<xdr:from>.*?<xdr:row>(\d+)</xdr:row>', x[2], re.S)[1]) + 1
        to = re.search(r'<xdr:to>.*?<xdr:row>(\d+)</xdr:row>', x[2], re.S)
        pics.append((row, media[e[1]], round(int(re.search(r'<a:ext cx="(\d+)"', x[2])[1]) / 12700, 1), int(to[1]) + 1 if to else row))
    cfg.FIXED.mkdir(exist_ok=True)
    blk = d['構成']; figs = {f['図']: f for f in d['図']}; extra = []
    for k, (row, name, wpt, to) in enumerate(sorted(pics), 1):
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


if __name__ == '__main__':
    main(sys.argv[1], cfg.Path(sys.argv[2]) if len(sys.argv) > 2 else None)
