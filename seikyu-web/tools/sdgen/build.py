# 4 設計書の作成：画面から取り出した項目（work\capture）＋補足入力.xlsx＋規則（sdgen\rules.py・style.py）から画面シートを作る
#   python build.py [出力.xlsx] [画面ID ...]
import datetime as dt, json, sys
from pathlib import Path
import openpyxl
from openpyxl.drawing.image import Image as XLImage
from openpyxl.utils import get_column_letter as L
from PIL import Image
from sdgen import cfg, book, rules, style as S

sys.stdout.reconfigure(encoding='utf-8')
COLS = ['Seq', '項目名称', '表示 / 区分', '必須', '初期値', '桁数', '少数', '形式', '参照元 / テーブル', '参照元項目', '備考']
FIELDS = ['項目名称', '区分', '必須', '初期値', '桁数', '少数', '形式', '参照元テーブル', '参照元項目', '備考']
LEGEND = '凡例　I＝入力／I/O＝条件付きの入力および表示／O＝表示のみ。水色＝入力項目、薄橙＝必須項目。〔 〕は画面上のエリア（検索条件・入力フォーム・一覧）。'
KIND_NOTE = [('I', '入力項目。この画面で入力する'), ('I/O', '条件付きの入力および表示'), ('O', '表示のみ（一覧・計算結果・採番値）')]
PX = 96 / 72


def cw(c1, c2='K'):
    """列 c1〜c2 の幅の合計"""
    return sum(S.WIDTH[chr(c)] for c in range(ord(c1), ord(c2) + 1))


def merge_items(sc, sup, cap, report):
    """補足入力の項目（並び・説明）と画面の項目（自動の値）を合わせる。区画ID → エリア → 行"""
    dom = {}
    for v in cap['views']:
        for a in v['areas']:
            for it in a['items']: dom.setdefault((v['id'], a['area']), []).append(it)
    out = {}
    for r in [x for x in sup['項目'] if x['画面ID'] == sc]:
        items = dom.get((r['区画ID'], r['エリア']), [])
        it = next((x for x in items if str(x.get('key')) == str(r['キー'])), None)
        row = dict(r)
        if it:
            items.remove(it); a = rules.auto(it, r)
            for c in ['区分', '必須', '初期値', '桁数', '形式']:
                if row[c] in ('', None): row[c] = a[c]
        else:
            report.append(f'補足のみ（画面に無い）: {r["区画ID"]} {r["エリア"]} {r["項目名称"]}（キー {r["キー"]}）')
        for c in FIELDS:
            if row.get(c) in ('', None): row[c] = '-'
        out.setdefault(r['区画ID'], []).append(row)
    for (vid, area), items in dom.items():   # 補足入力に無い画面の項目は末尾に載せて知らせる
        for it in items:
            a = rules.auto(it); row = {'区画ID': vid, 'エリア': area, '項目名称': it.get('label') or it.get('key'), **a, '少数': '-', '参照元テーブル': '-', '参照元項目': '-', '備考': '（補足入力なし）'}
            out.setdefault(vid, []).append(row); report.append(f'画面のみ（補足入力に無い）: {vid} {area} {row["項目名称"]}')
    return out


class Sheet:
    def __init__(self, ws):
        self.ws, self.r = ws, 1
        for c, w in S.WIDTH.items(): ws.column_dimensions[c].width = w
        ws.sheet_view.showGridLines = False
        ws.page_setup.orientation = 'landscape'; ws.sheet_properties.pageSetUpPr.fitToPage = True; ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0

    def cell(self, col, v, f=None, fl=None, al=S.TOP, box=True, r=None):
        c = self.ws[f'{col}{r or self.r}']; c.value = v
        c.font = f or S.font(); c.alignment = al
        if fl: c.fill = S.fill(fl)
        if box: c.border = S.BOX
        return c

    def merge(self, c1, c2, r=None):
        r = r or self.r; self.ws.merge_cells(f'{c1}{r}:{c2}{r}')
        for x in range(ord(c1), ord(c2) + 1): self.ws[f'{chr(x)}{r}'].border = S.BOX

    def skip(self, n=1): self.r += n

    def heading(self, text, size=10.5, h=None):
        self.cell('A', text, S.font(size, True, S.NAVY), box=False, al=None)
        if h: self.ws.row_dimensions[self.r].height = h
        self.skip()

    def head(self, cols):   # [(列, 見出し, 結合の終わり)]
        for c1, t, c2 in cols:
            self.cell(c1, t, S.font(9, True), 'head', S.CENTER)
            if c2: self.merge(c1, c2)
        self.skip()

    def row(self, cols, h=None):   # [(列, 値, 結合の終わり, 塗り, 中央)]
        hw = []
        for c1, v, c2, fl, center in cols:
            self.cell(c1, v, fl=fl, al=S.CENTER if center else S.TOP)
            if c2: self.merge(c1, c2)
            hw.append((v, cw(c1, c2 or c1)))
        self.ws.row_dimensions[self.r].height = h or S.height(hw); self.skip()

    def image(self, png, width_pt):
        img = Image.open(png); w = width_pt * PX; h = img.height * w / img.width
        x = XLImage(str(png)); x.width, x.height = round(w), round(h); x.anchor = f'A{self.r}'
        self.ws.add_image(x); self.skip(int(h / PX / 15) + 2)
        return x


def picture(spec, name):
    """図の指定（capture:名前＋名前／fixed:ファイル／report:ファイル）を PNG のパスにする"""
    spec = str(spec or '')
    if spec.startswith('fixed:'): return cfg.FIXED / spec[6:]
    if spec.startswith('report:'): return cfg.WORK / 'capture' / 'png' / (Path(spec[7:]).stem + '.png')   # finish.py が Excel を画像にする
    if spec.startswith('capture:'):
        parts = [cfg.WORK / 'capture' / 'png' / f'{p}.png' for p in spec[8:].split('+')]
        if len(parts) == 1: return parts[0]
        ims = [Image.open(p).convert('RGB') for p in parts]; w = max(i.width for i in ims)
        out = Image.new('RGB', (w, sum(i.height for i in ims) + 24 * (len(ims) - 1)), 'white'); y = 0
        for i in ims: out.paste(i, (0, y)); y += i.height + 24
        f = cfg.WORK / 'capture' / 'png' / f'{name}.png'; out.save(f); return f
    return None


def build_screen(wb, sc, sup, report, date):
    cap = json.loads((cfg.WORK / 'capture' / f'{sc}.json').read_text(encoding='utf-8'))
    pick = lambda k: [x for x in sup[k] if x['画面ID'] == sc]
    info, figs, parts, views, steps, rules_, reps = (pick(k) for k in ('画面', '図', '構成', '区画', '手順', 'ルール', '帳票'))
    items = merge_items(sc, sup, cap, report)
    ws = wb.create_sheet(sc); s = Sheet(ws)
    s.head([('A', '顧客名', None), ('B', 'システム名', 'C'), ('D', '文書', None), ('E', '作成日', None), ('F', '作成者', None)])
    for c in 'ABCDEF': ws[f'{c}1'].font = S.font(9, True, S.GRAY); ws[f'{c}1'].fill = S.fill('meta'); ws[f'{c}1'].alignment = S.TOP
    s.row([('A', S.CUSTOMER, None, None, False), ('B', S.SYSTEM, 'C', None, False), ('D', S.DOCNAME, None, None, False), ('E', date, None, None, False), ('F', '', None, None, False)])
    ws['E2'].number_format = 'yyyy/mm/dd'
    c = s.cell('A', '← 目次へ戻る', S.font(9, color=S.BLUE, underline='single'), box=False); c.hyperlink = "#'目次'!A1"; s.skip()
    title = next((x['内容'] for x in info if x['項目'] == '_見出し'), sc)
    s.heading(title, 13, 24); s.skip(2)
    s.heading('■ この画面の基本情報'); s.head([('A', '項目', None), ('B', '内容', 'K')])
    for x in [x for x in info if x['項目'] != '_見出し']:
        if not x['項目']: s.skip(); continue
        s.row([('A', x['項目'], None, None, False), ('B', x['内容'], 'K', None, False)])
    s.skip(2); s.heading('■ 画面図'); s.skip()
    pics = []
    for f in figs:
        s.cell('A', f['ラベル'], S.font(11, True), box=False, al=None); s.skip()
        p = picture(f['画像'], f'{sc}_図{f["順"]}')
        if p and p.exists(): pics.append((f, s.image(p, float(f['幅pt'] or 750))))
        else: report.append(f'図が無い: {f["ラベル"]} {f["画像"]}'); s.skip()
        s.skip()
    s.heading('■ 画面の構成'); s.head([('A', '確認項目', None), ('B', '内容', 'K')])
    for x in parts: s.row([('A', x['確認項目'], None, None, False), ('B', x['内容'], 'K', None, False)])
    s.skip(3)
    seq = 0
    for v in views:
        rows = items.get(v['区画ID'], [])
        s.heading(f'【画面項目】{v["区画ID"]}（{v["名称"]}）（表示 {len(rows)} 項目）', 13, 24); s.skip()
        s.heading('■ 表示区分の内訳'); s.head([('A', '表示区分', None), ('B', '件数', None), ('C', '意味', 'G')])
        count_rows = []
        for k, note in KIND_NOTE: count_rows.append(s.r); s.row([('A', k, None, None, True), ('B', '', None, None, True), ('C', note, 'G', None, False)])
        total = s.r; s.row([('A', '合計', None, None, True), ('B', f'=SUM(B{count_rows[0]}:B{count_rows[-1]})', None, None, True), ('C', 'この画面に表示される項目', 'G', None, False)])
        for c in 'ABC': ws[f'{c}{total}'].font = S.font(9, True)
        s.skip(); s.heading('■ 画面項目')
        s.head([(L(i + 1), t, None) for i, t in enumerate(COLS)]); ws.row_dimensions[s.r - 1].height = 28
        first, area = s.r, None
        for x in rows:
            if x['エリア'] != area:
                area = x['エリア']; s.cell('A', area, S.font(9, True), 'area'); s.merge('A', 'K'); s.skip()
            seq += 1; inp = x['区分'] in ('I', 'I/O')
            s.row([('A', seq, None, None, True), ('B', x['項目名称'], None, 'input' if inp else None, False), ('C', x['区分'], None, None, True), ('D', x['必須'], None, 'req' if x['必須'] == '○' else None, True),
                   ('E', x['初期値'], None, None, False), ('F', x['桁数'], None, None, True), ('G', x['少数'], None, None, True), ('H', x['形式'], None, None, False),
                   ('I', x['参照元テーブル'], None, None, False), ('J', x['参照元項目'], None, None, False), ('K', x['備考'], None, None, False)])
        last = s.r - 1
        for r_, (k, _) in zip(count_rows, KIND_NOTE): ws[f'B{r_}'] = f'=COUNTIF($C${first}:$C${last},"{k}")'; ws[f'B{r_}'].font = S.font(); ws[f'B{r_}'].alignment = S.CENTER; ws[f'B{r_}'].border = S.BOX
        s.cell('A', LEGEND, S.font(9, color=S.GRAY), box=False); s.ws.merge_cells(f'A{s.r}:K{s.r}'); s.skip(2)
        st = [x for x in steps if x['区画ID'] == v['区画ID']]
        if st:
            s.heading(f'【操作手順】{v["区画ID"]} {v["メニュー名"]}（{v["名称"]}）', 13, 24); s.skip()
            s.head([('A', '手順', None), ('B', '利用者の操作', None), ('C', '内容', 'E'), ('F', '画面の反応', 'I'), ('J', '備考', 'K')])
            for x in st: s.row([('A', x['手順'], None, None, True), ('B', x['利用者の操作'], None, None, False), ('C', x['内容'], 'E', None, False), ('F', x['画面の反応'], 'I', None, False), ('J', x['備考'], 'K', None, False)])
            s.skip(2)
    s.heading('■ 業務ルール・制約'); s.head([('A', 'No', None), ('B', '内容', 'K')])
    for x in rules_: s.row([('A', x['No'], None, None, True), ('B', x['内容'], 'K', None, False)])
    for x in reps:
        s.skip(2); s.heading('■ Excel 出力イメージ')
        if x['説明']: s.cell('A', x['説明'], box=False); s.skip()
        s.skip(); s.cell('A', x['ラベル'], S.font(11, True), box=False, al=None); s.skip()
        p = picture(x['画像'], f'{sc}_帳票')
        if p and p.exists(): s.image(p, float(x['幅pt'] or 842))
        else: report.append(f'帳票の図が無い: {x["ラベル"]} {x["画像"]}')
    # 矢印は finish.py が Excel で描く（openpyxl は図形を描けない）
    arrows = [{'from': n, 'to': int(f['矢印の終点']), 'x0': f['起点x'], 'y0': f['起点y'], 'x1': f['終点x'], 'y1': f['終点y']}
              for n, (f, _) in enumerate(pics, 1) if str(f.get('矢印の終点') or '').strip()]
    return {'sheet': sc, 'arrows': arrows, 'items': sum(len(v) for v in items.values())}


def main(out=None, screens=None):
    sup = book.load(cfg.SUPPLEMENT)
    scs = screens or sorted({x['画面ID'] for x in sup['画面']})
    date = dt.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    wb = openpyxl.Workbook(); toc = wb.active; toc.title = '目次'
    report, meta = [], []
    for sc in scs: meta.append(build_screen(wb, sc, sup, report, date))
    toc['A1'] = 'APLink 請求・入金管理システム　メニュー別機能対応表'; toc['A1'].font = S.font(13, True, S.NAVY)
    for i, sc in enumerate(scs, 3):
        c = toc.cell(i, 1, sc); c.hyperlink = f"#'{sc}'!A1"; c.font = S.font(9, color=S.BLUE, underline='single')
    out = Path(out or cfg.WORK / 'build' / f'画面設計_生成_{date:%Y%m%d}.xlsx'); out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    (out.parent / 'build.json').write_text(json.dumps({'out': str(out), 'sheets': meta}, ensure_ascii=False, indent=1), encoding='utf-8')
    (out.parent / 'build_report.txt').write_text('\n'.join(report) or '指摘なし', encoding='utf-8')
    print(f'{out}  ' + ' '.join(f'{m["sheet"]} 項目{m["items"]}' for m in meta)); print('\n'.join(report) or '指摘なし')


if __name__ == '__main__':
    a = sys.argv[1:]
    main(a[0] if a and a[0].endswith('.xlsx') else None, [x for x in a if not x.endswith('.xlsx')] or None)
