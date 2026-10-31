# 画面から取り出した項目（DOM）を設計書の列に直す規則。規則を変えるときはここを直して run_all.bat を実行し直す
import datetime as dt
import calendar, re
from functools import lru_cache
from sdgen import cfg


@lru_cache(None)
def dbdef():
    """DB 定義（test/schema/schema.sql）：{(表, 列): (桁数, 少数)}"""
    out, table = {}, None
    for line in cfg.SCHEMA.read_text(encoding='utf-8').splitlines():
        m = re.match(r'CREATE TABLE (\w+)', line)
        if m: table = m[1]; continue
        m = re.match(r'\s+(\w+) (character varying|numeric|character)\((\d+)(?:,(\d+))?\)', line)
        if table and m: out[(table, m[1])] = (int(m[3]), int(m[4] or 0))
        if line.startswith(')'): table = None
    return out

# 規則1 表示区分：I＝入力／I/O＝条件付きの入力および表示／O＝表示のみ
def kind(it):
    tag = it.get('tag')
    if tag == 'button':
        return 'I/O' if it.get('sample') else 'I'          # 一覧の行のボタン（取消など）は条件付き
    if tag in ('td', 'lineno', 'total', 'message'):
        return 'O'
    if it.get('disabled') or it.get('readonly'):
        return 'O'
    return 'I'


# 規則2 必須：項目名に * が付く入力欄（label.field.req）
def required(it):
    return '○' if it.get('required') else '-'


# 規則3 形式：日付・年月は MONTH／DATE、選択は SELECT、数値欄は NUMBER、ボタンは BUTTON、それ以外は VARCHAR
def form(it):
    tag = it.get('tag')
    if tag == 'button': return 'BUTTON'
    if tag in ('lineno', 'total'): return 'NUMBER'
    if it.get('fp') == 'month' or it.get('type') == 'month': return 'MONTH'
    if it.get('fp') == 'date' or it.get('type') == 'date': return 'DATE'
    if tag == 'select': return 'SELECT'
    if it.get('num'): return 'NUMBER'
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(it.get('sample') or '')): return 'DATE'   # 一覧の列：値が日付
    return 'VARCHAR'


# 規則4 桁数：入力欄の maxlength → 参照元（補足入力の 参照元テーブル・参照元項目）の DB の桁数 → 「-」
def digits(it, row=None):
    if str(it.get('maxlength') or '').isdigit(): return int(it['maxlength'])
    ref = dbdef().get((str((row or {}).get('参照元テーブル', '')), str((row or {}).get('参照元項目', ''))))
    return ref[0] if ref and it.get('tag') not in ('button', 'lineno', 'total', 'message') else '-'


# 規則5 初期値：入力値 → 選択中の表示 → 欄の案内（placeholder）の順。今日・当月などは言葉に直す
def initial(it, today=None):
    today = today or dt.date.today()
    tag = it.get('tag')
    if tag in ('button', 'message'): return '-'
    if tag == 'total': return it.get('value') or 0
    v = it.get('value') or it.get('selected') or ''
    if tag != 'select' and not v: v = it.get('placeholder') or ''
    if v in ('年-月-日', '年-月'): v = ''
    first, last = today.replace(day=1), today.replace(day=calendar.monthrange(today.year, today.month)[1])
    if v == first.isoformat() and '開始' in (it.get('label') or ''): return '当月1日'   # 期間の開始（1日に実行すると本日と重なる）
    if v == today.isoformat(): return '本日'
    if v == first.isoformat(): return '当月1日'
    if v == last.isoformat(): return '当月末日'
    if v == today.strftime('%Y-%m'): return '当月'
    return v or '-'


def auto(it, row=None):
    """補足入力が空欄のときに使う列の値（row＝補足入力の項目の行。参照元から桁数を引く）"""
    return {'区分': kind(it), '必須': required(it), '形式': form(it), '桁数': digits(it, row), '初期値': initial(it)}
