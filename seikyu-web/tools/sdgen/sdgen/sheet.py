# 設計書の画面シートを部品（構成・表・図・項目・手順。補足入力と同じ形）に分ける。migrate.py（移し替え）と変更点（前の版との差分）で使う
import re
from sdgen import book

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
    m = re.search(r'Target="(?:\.\./|/xl/)drawings/([^"]+)"', z.read(srel).decode()) if srel in z.namelist() else None   # Excel は ../、openpyxl は /xl/
    return m[1] if m else None


def pictures(z, sc):
    """シートの図 → [(上端の行, xl/media のファイル名, 幅pt, 下端の行)]（上から）"""
    dr = drawing_of(z, sc)
    if not dr: return []
    dx = z.read(f'xl/drawings/{dr}').decode(); drel = z.read(f'xl/drawings/_rels/{dr}.rels').decode()
    media = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="(?:\.\./|/xl/)media/([^"]+)"', drel)) or {b: a for a, b in re.findall(r'Target="(?:\.\./|/xl/)media/([^"]+)"[^>]*Id="(rId\d+)"', drel)}
    pics = []
    for x in re.finditer(r'<(?:xdr:)?(twoCellAnchor|oneCellAnchor)[^>]*>(.*?)</(?:xdr:)?\1>', dx, re.S):   # Excel は xdr: 付き、openpyxl は付かない
        e = re.search(r'r:embed="(rId\d+)"', x[2])
        if not e: continue
        row = int(re.search(r'<(?:xdr:)?from>.*?<(?:xdr:)?row>(\d+)</(?:xdr:)?row>', x[2], re.S)[1]) + 1
        to = re.search(r'<(?:xdr:)?to>.*?<(?:xdr:)?row>(\d+)</(?:xdr:)?row>', x[2], re.S)
        cx = re.search(r'<a:ext cx="(\d+)"', x[2]) or re.search(r'<(?:xdr:)?ext cx="(\d+)"', x[2])
        pics.append((row, media[e[1]], round(int(cx[1]) / 12700, 1), int(to[1]) + 1 if to else row))
    return sorted(pics)
