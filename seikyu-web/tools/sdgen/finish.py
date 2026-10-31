# 5 仕上げ：build.py の結果に Excel で矢印を描く（補足入力の 図 の「矢印の終点」）。openpyxl は図形を描けないため
import json, sys
import win32com.client as w
from sdgen import cfg

sys.stdout.reconfigure(encoding='utf-8')


def main(meta_path=None):
    meta = json.loads(cfg.Path(meta_path or cfg.WORK / 'build' / 'build.json').read_text(encoding='utf-8'))
    todo = [m for m in meta['sheets'] if m['arrows']]
    if not todo: print('矢印なし'); return
    xl = w.DispatchEx('Excel.Application'); xl.Visible = False; xl.DisplayAlerts = False
    try:
        wb = xl.Workbooks.Open(meta['out'])
        for m in todo:
            ws = wb.Worksheets(m['sheet'])
            figs = sorted([x for x in ws.Shapes if x.Type == 13], key=lambda x: x.Top)   # 画面図の順（上から）
            for a in m['arrows']:
                p, q = figs[a['from'] - 1], figs[a['to'] - 1]
                x0, y0 = p.Left + p.Width * float(a['x0']), p.Top + p.Height * float(a['y0'])
                x1, y1 = q.Left + q.Width * float(a['x1']), q.Top + q.Height * float(a['y1'])
                c = ws.Shapes.AddConnector(1, x0, y0, x1, y1)
                c.Line.EndArrowheadStyle = 2; c.Line.Weight = 1.5; c.Line.ForeColor.RGB = 0xC07A44   # 青（BGR）
                print(f'{m["sheet"]}: 図{a["from"]} → 図{a["to"]}')
        wb.Save(); wb.Close(False)
    finally:
        xl.Quit()


if __name__ == '__main__':
    main(*sys.argv[1:2])
