# メニュー（capture.py が読んだサイドバー）と設計書のシートの対応を調べる。表記は「メニュー ＞ 小メニュー」（開閉グループは「グループ ＞ メニュー」）
import json, re
from sdgen import cfg

SEP = ' ＞ '


def norm(t):
    return re.sub(r'\s*[＞>›]\s*', SEP, re.sub(r'\s+', ' ', str(t or '')).strip())


def expand(path):
    """「商品仕入 ＞ 一覧・登録／登録リスト」→ 小メニューごとの表記"""
    path = norm(path)
    if SEP not in path: return [path]
    head, tail = path.split(SEP, 1)
    return [head + SEP + x.strip() for x in tail.split('／')]


def load():
    """→ [(表記, 状態)]。状態：表示／使用不可（小メニューの無いメニューはメニューそのもの）"""
    f = cfg.WORK / 'capture' / '_menu.json'
    if not f.exists(): return None
    out = []
    for m in json.loads(f.read_text(encoding='utf-8')):
        base = m['fold'] + SEP + m['title'] if m['fold'] else m['title']
        if not m['subs']: out.append((base, '表示')); continue
        for s in m['subs']: out.append((base + SEP + s['title'], '使用不可' if s['disabled'] else '表示'))
    return out


def screen_name(sup):
    """補足入力の表の「画面名」（最初のもの）"""
    return next((str(t['右']) for t in sup['表'] if t['左'] == '画面名'), '')


def check(sheets, flow, captured):
    """sheets＝[(シート名, 画面名, 目次に載せる)]、flow＝業務フローの [(No, 新システムの画面)]、captured＝{シート名: 開いた画面のメニュー}
    → (報告の行, 対応表の行)"""
    menu = load()
    if menu is None: return ['メニュー: 取り出し結果なし（capture.py を全画面で実行）'], []
    shown = {p for p, st in menu if st == '表示'}
    tops = {p.split(SEP)[0] for p, _ in menu} | {SEP.join(p.split(SEP)[:2]) for p, _ in menu if p.count(SEP) == 2}
    report, table, by_path = [], [], {}
    for sh, name, listed in sheets:
        paths = expand(name)
        for p in paths: by_path.setdefault(p, []).append(sh)
        bad = [p for p in paths if p not in shown]
        if bad: report.append(f'メニュー: {sh} の画面名「{name}」がメニューに無い（{"・".join(bad)}）')
        cap = norm(captured.get(sh, ''))
        if cap and cap not in paths and cap.split(SEP)[-1] not in [p.split(SEP)[-1] for p in paths]:
            report.append(f'メニュー: {sh} の画面名「{name}」と開いた画面のメニュー「{cap}」が違う')
        if not listed: report.append(f'メニュー: {sh} は目次に載っていない')
    for p, st in menu:
        sh = by_path.get(p, [])
        table.append((p, st, '・'.join(sh)))
        if st == '表示' and not sh: report.append(f'メニュー: シートが無い ＝ {p}')
    for no, text in flow:
        t = norm(text)
        if not t or t.startswith(('—', '（', '-')) or (SEP not in t and t not in tops): continue   # 「＞」の無い文はメニューの表記ではない
        paths = expand(t) if all(x in shown or x in tops for x in expand(t)) else expand(re.sub(r'（[^）]*）$', '', t))
        bad = [p for p in paths if p not in shown and p not in tops]
        if bad: report.append(f'メニュー: 業務フロー {no} の「{text}」がメニューに無い（{"・".join(bad)}）')
    return report, table
