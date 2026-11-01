# 補足入力の読み書き。1画面＝1ファイル（補足入力\<画面ID>.xlsx）。シートの並び（構成）と中身（表・図・項目・手順）
from pathlib import Path
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from sdgen import cfg

SHEETS = {
    # 画面シートを上から並べた部品。種類：表紙・戻る・見出し大・見出し中・文・空行・表・図・項目・手順
    '構成': ['順', '種類', '区画ID', '文字', '見出し1', '見出し2'],
    '表': ['表', '順', '左', '右'],                       # 表＝構成の「順」
    '図': ['図', 'ラベル', '画像', '幅pt', '矢印の終点', '起点x', '起点y', '終点x', '終点y'],
    '項目': ['区画ID', 'エリア', 'キー', '項目名称', '区分', '必須', '初期値', '桁数', '少数', '形式', '参照元テーブル', '参照元項目', '備考'],
    '手順': ['区画ID', '手順', '利用者の操作', '内容', '画面の反応', '備考'],
}
GUIDE = [
    '補足入力：画面から自動で取れない内容。1ファイル＝1画面シート。',
    '構成シート：画面シートを上から並べた部品。種類＝表紙／戻る／見出し大／見出し中／文／空行（文字＝行数）／表（見出し1・2＝列見出し、中身は表シート）／図（中身は図シート）／項目（区画IDの画面項目。文字＝見出し、{n}＝項目数）／手順（区画IDの操作手順）。',
    '項目シート：区分・必須・初期値・桁数・形式が空欄なら画面から自動で決める（tools/sdgen/sdgen/rules.py）。値を書くとその値を使う。キー＝画面の項目名（見出し・ラベル）、ラベルのない欄は name 属性。',
    '図シート：図＝構成の「順」。画像＝ fixed:ファイル名（tools/sdgen/fixed）／ capture:撮影名（＋で縦に並べる）／ report:帳票名。矢印の終点＝矢印を引く先の図（画面シートの上からの番号）、起点x・y／終点x・y は図の中の位置（0〜1）。',
]


# 画面シート以外（目次・業務フロー・変更点）の補足入力：補足入力\_共通.xlsx。V13・V14… の列（版ごとの 追加／更新）は列見出し V＋数字で足す
COMMON = {
    '文': ['シート', '位置', '文字'],                      # 位置：題・説明・注。{n}＝目次のシート数
    '目次': ['シート名', '載せる'],                        # 並び＝設計書のシートの並び。載せる＝○ のシートだけ目次に出す
    '業務フロー': ['業務', '順', '処理', '新システムの画面', '画面ID', '決定事項'],   # 新システムの画面が空欄なら画面IDのシートの画面名から
    '変更点': ['版', 'No', 'メニュー', 'シート', '変更内容', '根拠', 'シートの扱い'],   # 人が書いた変更点。版ごとに「<版>変更点」シートになる
}
COMMON_GUIDE = [
    '補足入力（共通）：画面シート以外のシート（目次・業務フロー・変更点）の内容。',
    '文シート：シートの題・説明・注。目次の説明の {n} はシート数。',
    '目次シート：設計書の画面シートの並び。載せる＝○ のシートだけ目次に出す。V13・V14… の列は版ごとの 追加／更新（次の版の列は前の版との差分から自動）。',
    '業務フロー：新システムの画面が空欄なら画面IDのシートの「画面名」から作る（画面IDが複数なら ／ でつなぐ）。V13・V14… の列は目次と同じ。',
    '変更点：人が書く変更点（版＝V14 など）。次の版の変更点シートは前の版との差分から自動で作り、ここに同じ版の行があれば先に載せる。',
]


def path_of(sc):
    return cfg.SUPPLEMENT / f'{sc}.xlsx'


def versions(rows):
    """行の列見出しのうち版（V＋数字）を古い順に"""
    import re
    return sorted({k for r in rows for k in r if re.fullmatch(r'V\d+', k)}, key=lambda k: int(k[1:]))


def load_common():
    return load('_共通', COMMON)


def save_common(data):
    cols = {k: v + versions(data.get(k, [])) if k in ('目次', '業務フロー') else v for k, v in COMMON.items()}
    save('_共通', data, cols, COMMON_GUIDE)


def screens():
    return sorted(p.stem for p in cfg.SUPPLEMENT.glob('SC-*.xlsx'))


def load(sc, sheets=SHEETS):
    p = path_of(sc); out = {k: [] for k in sheets}
    if not p.exists(): return out
    wb = openpyxl.load_workbook(p, data_only=True)
    for name in sheets:
        if name not in wb.sheetnames: continue
        ws = wb[name]; head = [c.value for c in ws[1]]
        for r in ws.iter_rows(min_row=2, values_only=True):
            if not any(v not in (None, '') for v in r): continue
            out[name].append({h: ('' if v is None else v) for h, v in zip(head, r) if h})
    return out


def save(sc, data, sheets=SHEETS, guide=GUIDE):
    cfg.SUPPLEMENT.mkdir(parents=True, exist_ok=True)
    wb = openpyxl.Workbook(); wb.remove(wb.active)
    g = wb.create_sheet('説明')
    for i, t in enumerate(guide, 1): g.cell(i, 1, t)
    g.column_dimensions['A'].width = 160
    for name, cols in sheets.items():
        ws = wb.create_sheet(name); ws.append(cols)
        for c in ws[1]: c.font = Font(bold=True); c.fill = PatternFill('solid', fgColor='CADCFC')
        for r in data.get(name, []): ws.append([r.get(c, '') for c in cols])
        for i, c in enumerate(cols, 1):
            ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = 70 if c in ('文字', '右', '備考', '画面の反応', '内容', '利用者の操作', '処理', '決定事項', '変更内容') else 16
        for row in ws.iter_rows(min_row=2):
            for c in row: c.alignment = Alignment(wrap_text=True, vertical='top')
        ws.freeze_panes = 'A2'
    wb.save(path_of(sc))
