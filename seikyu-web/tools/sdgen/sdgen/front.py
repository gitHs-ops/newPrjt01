# 画面シートの前のシート（目次・業務フロー・変更点）。読む（既存の設計書 → 補足入力の形）と作る（補足入力＋自動 → シート）
import re
from openpyxl.utils import get_column_letter as L
from sdgen import style as S
from sdgen.menu import SEP, norm
from sdgen.sheet import s

FLOW_HEAD = {'No': 'No', '業務': '業務', '順': '順', '処理（業務の流れ）': '処理', '新システムの画面（メニュー）': '新システムの画面', '画面ID': '画面ID'}
CHANGE_COLS = [('No', 'No', 5), ('メニュー', 'メニュー', 14.5), ('シート', 'シート', 18.5), ('変更内容', '変更内容', 70.5), ('根拠（日付・コミット）', '根拠', 26.5), ('シートの扱い', 'シートの扱い', 20.5)]
MARK = 'FFF2CC'


def sheet_in_docs(name, src, wb=None):
    """src の版から古い版へ順に探し、そのシートのある最初の版 → (シート, パス)。無ければ (None, None)"""
    import openpyxl
    from sdgen import cfg
    if wb is None and src: wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    if wb is not None and name in wb.sheetnames: return wb[name], src
    docs = cfg.docs(); top = next((v for v, p in docs if p == src), None)
    for v, p in docs:
        if top is not None and v >= top: continue
        w = openpyxl.load_workbook(p, read_only=True, data_only=True)
        if name in w.sheetnames: return w[name], p
    return None, None


def _table(ws):
    """4行目が列見出しの表 → ({見出し: 列の位置}, [5行目からの行（文字）])"""
    rows = [[s(x) for x in r] for r in ws.iter_rows(values_only=True)]
    w = max(map(len, rows)); rows = [r + [''] * (w - len(r)) for r in rows]
    return {h: i for i, h in enumerate(rows[3]) if h}, rows[4:]


def is_ver(h):
    return bool(re.fullmatch(r'V\d+', h))


def read_toc(ws):
    """目次 → [{シート名, V13…}]"""
    h, rows = _table(ws)
    return [{'シート名': r[h['シート名']], **{k: r[i] for k, i in h.items() if is_ver(k)}} for r in rows if r[h['シート名']]]


def read_flow(ws):
    """業務フロー → ([{業務, 順, 処理, 新システムの画面, 画面ID, 決定事項, V13…}], 注)"""
    h, rows = _table(ws); out, note, grp = [], '', ''
    dec = next(i for k, i in h.items() if k.startswith('決定事項'))
    for r in rows:
        if r[0] == '注': note = r[1]; continue
        if not any(r): continue
        grp = r[h['業務']] or grp
        row = {key: r[h[head]] for head, key in FLOW_HEAD.items() if key not in ('No', '業務')}
        row.update({'業務': grp, '決定事項': r[dec], **{k: r[i] for k, i in h.items() if is_ver(k)}})
        out.append(row)
    return out, note


def read_changes(ws, ver):
    """V14変更点 など → [{版, No, メニュー, シート, 変更内容, 根拠, シートの扱い}]"""
    h, rows = _table(ws)
    return [{'版': ver, **{key: r[h[head]] for head, key, _ in CHANGE_COLS if head in h}} for r in rows if any(r)]


def auto_screen(ids, names):
    """画面ID（「・」区切り）→ 画面名からメニューの表記。同じメニューなら「メニュー ＞ 小1／小2」。わからなければ空"""
    got = [norm(names.get(x.strip(), '')) for x in str(ids).split('・')]
    if not got or not all(got): return ''
    heads = {g.split(SEP)[0] for g in got}
    if len(heads) == 1 and all(SEP in g for g in got): return got[0].split(SEP)[0] + SEP + '／'.join(g.split(SEP, 1)[1] for g in got)
    return '／'.join(got)


class Front:
    """題・説明・戻る・見出しの付いた一覧シート"""
    def __init__(self, wb, title, index, widths):
        self.ws = wb.create_sheet(title, index); self.r = 1
        for i, w in enumerate(widths, 1): self.ws.column_dimensions[L(i)].width = w
        self.ws.sheet_view.showGridLines = False; self.ws.freeze_panes = 'A5'

    def top(self, title, desc, back=True):
        ws = self.ws
        ws['A1'] = title; ws['A1'].font = S.font(13, True, S.NAVY); ws.row_dimensions[1].height = 18
        ws['A2'] = desc; ws['A2'].font = S.font(9, color=S.GRAY)
        if back: ws['A3'] = '← 目次へ戻る'; ws['A3'].font = S.font(9, color=S.BLUE, underline='single'); ws['A3'].hyperlink = "#'目次'!A1"
        self.r = 4

    def head(self, cols):
        for i, t in enumerate(cols, 1):
            c = self.ws.cell(self.r, i, t); c.font = S.font(9, True); c.fill = S.fill('head'); c.border = S.BOX; c.alignment = S.CENTER
        self.r += 1

    def row(self, vals, center=(), fills=None, bold=(), wide=()):
        hw = []
        for i, v in enumerate(vals, 1):
            c = self.ws.cell(self.r, i, v if v != '' else None); c.font = S.font(9, i in bold); c.border = S.BOX
            c.alignment = S.CENTER if i in center else S.TOP
            if fills and fills.get(i) and v not in ('', None): c.fill = S.fill_rgb(fills[i])
            if i in wide: hw.append((v, self.ws.column_dimensions[L(i)].width))
        if hw: self.ws.row_dimensions[self.r].height = S.height(hw)
        self.r += 1
        return self.r - 1


def toc(wb, rows, title, desc, vers):
    """rows＝[{シート名, 画面名, 機能NO, V13…}]（目次に載せるものだけ）"""
    f = Front(wb, '目次', 0, [5.8, 18.3, 50, 37.2] + [6.5] * len(vers))
    f.top(title, desc.replace('{n}', str(len(rows))), back=False)
    f.head(['No', 'シート名', '内容／画面名', '機能NO／画面ID'] + vers)
    for n, x in enumerate(rows, 1):
        r = f.row([n, x['シート名'], x['画面名'], x['機能NO']] + [x.get(v, '') for v in vers], center={1, *range(5, 5 + len(vers))}, fills={i: MARK for i in range(5, 5 + len(vers))})
        c = f.ws.cell(r, 2); c.hyperlink = f"#'{x['シート名']}'!A1"; c.font = S.font(9, color=S.BLUE, underline='single')


def flow(wb, rows, title, desc, note, vers, index):
    """rows＝[{業務, 順, 処理, 新システムの画面, 画面ID, 決定事項, V13…}]（業務の順）"""
    nv = len(vers); f = Front(wb, '業務フロー', index, [5, 16.5, 5, 34.5, 30.5, 13.5] + [6.5] * nv + [52.5])
    f.top(title, desc); f.head(['No', '業務', '順', '処理（業務の流れ）', '新システムの画面（メニュー）', '画面ID'] + vers + ['決定事項・未確認（会議メモ）・' + (vers[-1] if vers else '') + ' の変更'])
    grp, start, no = None, None, 0
    def close(end):
        if start and end > start:
            for col in 'AB': f.ws.merge_cells(f'{col}{start}:{col}{end}')
    for x in rows:
        first = x['業務'] != grp
        if first: close(f.r - 1); grp, start = x['業務'], f.r; no += 1
        f.row([no if first else '', x['業務'] if first else '', int(x['順']) if str(x['順']).isdigit() else x['順'], x['処理'], x['新システムの画面'], x['画面ID']] + [x.get(v, '') for v in vers] + [x['決定事項']],
              center={1, 3, *range(7, 7 + nv)}, fills={6: S.FILL['req'], **{i: MARK for i in range(7, 7 + nv)}}, bold={2}, wide={4, 5, 7 + nv})
    close(f.r - 1)
    if note: f.r += 1; f.ws.cell(f.r, 1, '注').font = S.font(); f.ws.cell(f.r, 2, note).font = S.font()
    return f.ws


def changes(wb, name, rows, title, desc, index):
    f = Front(wb, name, index, [w for _, _, w in CHANGE_COLS])
    f.top(title, desc); f.head([h for h, _, _ in CHANGE_COLS])
    for n, x in enumerate(rows, 1):
        f.row([n] + [x.get(k, '') for _, k, _ in CHANGE_COLS[1:]], center={1}, wide={4, 5})
