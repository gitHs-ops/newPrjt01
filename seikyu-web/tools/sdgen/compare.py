# 6 照合：作った画面シートと既存の設計書（既定は最新版）の同じシートを、文字の並びで比べる（行の位置・書式・画面項目の Seq・列見出しの改行は見ない）
#   python compare.py [SC-PUR-01] [生成.xlsx] [既存.xlsx]   … 画面IDを省くと build.py で作った全シート
import difflib, json, re, sys
from pathlib import Path
import openpyxl
from sdgen import cfg

sys.stdout.reconfigure(encoding='utf-8')
SKIP = ('=COUNTIF', '=SUM')


def lines(path, sheet):
    ws = openpyxl.load_workbook(path, read_only=True)[sheet]; out = []
    for row in ws.iter_rows(values_only=True):
        cells = [str(v).strip() for v in row if v not in (None, '') and not str(v).startswith(SKIP)]
        cells = [c[:-2] if c.endswith('.0') and c[:-2].isdigit() else c.replace(' 00:00:00', '') for c in cells]
        if not cells: continue
        if cells[0] == 'Seq': cells = ['Seq', '（画面項目の列見出し）']                       # 列見出しの改行の違いは見ない
        elif len(cells) > 3 and re.fullmatch(r'\d+', cells[0]) and cells[2] in ('I', 'O', 'I/O'): cells = cells[1:]   # 画面項目の Seq は振り直すので見ない
        out.append(' | '.join(cells))
    return [x for x in out if not x.startswith('中部土木')]   # 作成日の行は比べない


def main(sheet, gen=None, old=None):
    gen = Path(gen or json.loads((cfg.WORK / 'build' / 'build.json').read_text(encoding='utf-8'))['out'])
    old = Path(old or cfg.latest_doc())
    a, b = lines(old, sheet), lines(gen, sheet)
    diff = list(difflib.unified_diff(a, b, f'{old.name}', f'{gen.name}', lineterm='', n=0))
    out = cfg.WORK / 'build' / f'compare_{sheet}.txt'
    out.write_text('\n'.join(diff) or '差異なし', encoding='utf-8')
    same = sum(1 for x in a if x in set(b))
    print(f'{sheet}: 既存 {len(a)} 行・生成 {len(b)} 行・一致 {same} 行（{same * 100 // max(len(a), 1)}%）  差分 {out}')


if __name__ == '__main__':
    if len(sys.argv) > 1: main(*sys.argv[1:])
    else:
        for m in json.loads((cfg.WORK / 'build' / 'build.json').read_text(encoding='utf-8'))['sheets']: main(m['sheet'])
