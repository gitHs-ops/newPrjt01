# 3 帳票の画像：capture.py がダウンロードした帳票（work\capture\*.xlsx）の1ページ目を Excel で PNG にする（補足入力の 画像＝report:名前 で使う）
import sys, time
import win32com.client as w
from sdgen import cfg

sys.stdout.reconfigure(encoding='utf-8')


def main():
    files = sorted((cfg.WORK / 'capture').glob('*.xlsx'))
    if not files: print('帳票なし'); return
    xl = w.DispatchEx('Excel.Application'); xl.Visible = False; xl.DisplayAlerts = False
    try:
        for f in files:
            wb = xl.Workbooks.Open(str(f), ReadOnly=True); ws = wb.Worksheets(1); wb.Activate(); xl.ActiveWindow.DisplayGridlines = False
            rg = ws.UsedRange; rg.CopyPicture(1, 2)
            co = ws.ChartObjects().Add(0, 0, rg.Width, rg.Height); co.Activate(); time.sleep(0.4); co.Chart.Paste(); time.sleep(0.4)
            co.Chart.ChartArea.Format.Line.Visible = 0
            png = cfg.WORK / 'capture' / 'png' / (f.stem + '.png'); co.Chart.Export(str(png)); wb.Close(False)
            print(f'{f.name} → {png.name}')
    finally:
        xl.Quit()


if __name__ == '__main__':
    main()
