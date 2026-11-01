# 7 保存：build.py で作った設計書を設計書フォルダに次の版（seikyu-web_画面設計_YYYYMMDDVn.xlsx）として保存し、
#   その版の 追加／更新 の列と「<版>変更点」を補足入力 _共通.xlsx の履歴に書く（次に作り直しても同じ版の内容が出るように）
#   python publish.py [生成.xlsx]     … 既定は build.json の出力。run_all.bat の後に実行する
import json, shutil, sys
from pathlib import Path
import openpyxl
from sdgen import cfg, book, front

sys.stdout.reconfigure(encoding='utf-8')


def main(gen=None):
    info = json.loads((cfg.WORK / 'build' / 'build.json').read_text(encoding='utf-8'))
    gen = Path(gen or info['out']); ver = info['next']
    docs = cfg.docs(); top = docs[0][0] if docs else 0
    if int(ver[1:]) != top + 1: raise SystemExit(f'作ったときの次の版 {ver} と設計書フォルダの最新 V{top} が合わない。build.py からやり直す')
    dst = cfg.DOC_DIR / f'seikyu-web_画面設計_{gen.stem[-8:]}{ver}.xlsx'
    if dst.exists(): raise SystemExit(f'既にある：{dst.name}')
    if (dst.parent / ('~$' + dst.name)).exists(): raise SystemExit(f'Excel で開かれている：{dst.name}')

    wb = openpyxl.load_workbook(gen, read_only=True, data_only=True); c = book.load_common()
    toc = {r['シート名']: r.get(ver, '') for r in front.read_toc(wb['目次'])}
    for r in c['目次']: r[ver] = toc.get(r['シート名'], '')
    flow = {(r['業務'], r['処理']): r.get(ver, '') for r in front.read_flow(wb['業務フロー'])[0]}
    for r in c['業務フロー']: r[ver] = flow.get((r['業務'], r['処理']), '')
    name = f'{ver}変更点'
    if name in wb.sheetnames:
        ws = wb[name]; rows = [[x for x in r] for r in ws.iter_rows(min_row=1, max_row=2, max_col=1, values_only=True)]
        c['変更点'] = [r for r in c['変更点'] if r['版'] != ver] + front.read_changes(ws, ver)
        c['文'] = [t for t in c['文'] if t['シート'] != name] + [{'シート': name, '位置': '題', '文字': rows[0][0] or ''}, {'シート': name, '位置': '説明', '文字': rows[1][0] or ''}]
    wb.close()
    shutil.copyfile(gen, dst)
    book.save_common(c)
    marked = sum(1 for v in toc.values() if v)
    print(f'{gen.name} → {dst}\n補足入力 _共通.xlsx に {ver} を記録（目次 {marked} シート・業務フロー {sum(1 for v in flow.values() if v)} 行・{name} {sum(1 for r in c["変更点"] if r["版"] == ver)} 件）')


if __name__ == '__main__':
    main(*sys.argv[1:2])
