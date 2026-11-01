# 6 照合：作ったシートと既存の設計書（既定は最新版）の同じシートを、文字の並びで比べる（行の位置・書式・画面項目の Seq・列見出しの改行は見ない）
#   python compare.py [シート名] [生成.xlsx] [既存.xlsx]   … シート名を省くと build.py で作った全シート（目次・業務フロー・変更点を含む）
#   既存の版にシートが無いときは、それより前の版で探す
import difflib, functools, json, re, sys
from pathlib import Path
import openpyxl
from sdgen import cfg

sys.stdout.reconfigure(encoding='utf-8')
SKIP = ('=COUNTIF', '=SUM')


@functools.lru_cache(None)
def book(path, values):
    return openpyxl.load_workbook(path, read_only=True, data_only=values)


def lines(path, sheet):
    """式は Excel が保存した値で比べる（区分の件数・合計の式は見ない）"""
    out = []
    for rf, rv in zip(book(path, False)[sheet].iter_rows(values_only=True), book(path, True)[sheet].iter_rows(values_only=True)):
        cells = [str(v).strip() for f, v in zip(rf, rv) if v not in (None, '') and not str(f).startswith(SKIP)]
        cells = [c[:-2] if c.endswith('.0') and c[:-2].isdigit() else c.replace(' 00:00:00', '') for c in cells]
        if not cells: continue
        if cells[0] == 'Seq': cells = ['Seq', '（画面項目の列見出し）']                       # 列見出しの改行の違いは見ない
        elif len(cells) > 3 and re.fullmatch(r'\d+', cells[0]) and cells[2] in ('I', 'O', 'I/O'): cells = cells[1:]   # 画面項目の Seq は振り直すので見ない
        out.append(' | '.join(cells))
    return [x for x in out if not x.startswith('中部土木')]   # 作成日の行は比べない


def find_old(sheet, old):
    """既存の版（無ければそれより前の版）でシートを探す"""
    if sheet in book(old, False).sheetnames: return old
    top = next((v for v, p in cfg.docs() if p == old), 10 ** 6)
    return next((p for v, p in cfg.docs() if v < top and sheet in book(p, False).sheetnames), None)


def main(sheet, gen=None, old=None):
    gen = Path(gen or json.loads((cfg.WORK / 'build' / 'build.json').read_text(encoding='utf-8'))['out'])
    old = find_old(sheet, Path(old or cfg.latest_doc()))
    if not old: print(f'{sheet}: 既存の版に無い（比べない）'); return
    a, b = lines(old, sheet), lines(gen, sheet)
    diff = list(difflib.unified_diff(a, b, f'{old.name}', f'{gen.name}', lineterm='', n=0))
    out = cfg.WORK / 'build' / f'compare_{sheet}.txt'
    out.write_text('\n'.join(diff) or '差異なし', encoding='utf-8')
    same = sum(1 for x in a if x in set(b)); extra = sum(1 for x in b if x not in set(a))
    print(f'{sheet}: 既存 {len(a)} 行・生成 {len(b)} 行・一致 {same} 行（{same * 100 // max(len(a), 1)}%）・生成のみ {extra} 行  {old.name}  差分 {out.name}')


if __name__ == '__main__':
    if len(sys.argv) > 1: main(*sys.argv[1:])
    else:
        info = json.loads((cfg.WORK / 'build' / 'build.json').read_text(encoding='utf-8'))
        for name in info.get('front', []) + [m['sheet'] for m in info['sheets']]: main(name)
