# 補足入力.xlsx の読み書き。1画面＝各シートの「画面ID」が同じ行
from pathlib import Path
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

SHEETS = {
    '画面': ['画面ID', '順', '項目', '内容'],
    '図': ['画面ID', '順', 'ラベル', '画像', '幅pt', '矢印の終点', '起点x', '起点y', '終点x', '終点y'],
    '構成': ['画面ID', '順', '確認項目', '内容'],
    '区画': ['画面ID', '区画ID', '名称', 'メニュー名'],
    '項目': ['画面ID', '区画ID', 'エリア', 'キー', '項目名称', '区分', '必須', '初期値', '桁数', '少数', '形式', '参照元テーブル', '参照元項目', '備考'],
    '手順': ['画面ID', '区画ID', '手順', '利用者の操作', '内容', '画面の反応', '備考'],
    'ルール': ['画面ID', 'No', '内容'],
    '帳票': ['画面ID', '説明', 'ラベル', '画像', '幅pt'],
}
GUIDE = [
    '補足入力：画面から自動で取れない内容を書く。1行＝1件。「画面ID」で画面を分ける。',
    '項目シート：区分・必須・初期値・桁数・形式が空欄なら画面から自動で決める（tools/sdgen/sdgen/rules.py）。値を書くとその値を使う。',
    '項目シート：キー＝画面の項目名（見出し・ラベル）、ラベルのない欄は name 属性。画面に無いキーは「補足のみ」としてそのまま載る。',
    '図シート：画像＝ capture:名前（＋でつなぐと縦に並べる）／ fixed:ファイル名（tools/sdgen/fixed）。矢印の終点＝矢印を引く先の図の「順」、起点x・y／終点x・y は図の中の位置（0〜1）。',
    '帳票シート：画像＝ report:ダウンロード名（Excel を画像にする）／ fixed:ファイル名。',
]


def load(path):
    path = Path(path)
    if not path.exists():
        return {k: [] for k in SHEETS}
    wb = openpyxl.load_workbook(path, data_only=True)
    out = {}
    for name, cols in SHEETS.items():
        rows = []
        if name in wb.sheetnames:
            ws = wb[name]; head = [c.value for c in ws[1]]
            for r in ws.iter_rows(min_row=2, values_only=True):
                if not any(v not in (None, '') for v in r): continue
                rows.append({h: ('' if v is None else v) for h, v in zip(head, r) if h})
        out[name] = rows
    return out


def save(path, data):
    wb = openpyxl.Workbook(); wb.remove(wb.active)
    g = wb.create_sheet('説明')
    for i, t in enumerate(GUIDE, 1): g.cell(i, 1, t)
    g.column_dimensions['A'].width = 140
    head_font, head_fill = Font(bold=True), PatternFill('solid', fgColor='CADCFC')
    for name, cols in SHEETS.items():
        ws = wb.create_sheet(name); ws.append(cols)
        for c in ws[1]: c.font = head_font; c.fill = head_fill
        for r in data.get(name, []): ws.append([r.get(c, '') for c in cols])
        for i, c in enumerate(cols, 1):
            ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = 60 if c in ('内容', '備考', '画面の反応', '利用者の操作', '説明') else 14
        for row in ws.iter_rows(min_row=2):
            for c in row: c.alignment = Alignment(wrap_text=True, vertical='top')
        ws.freeze_panes = 'A2'
    wb.save(path)
