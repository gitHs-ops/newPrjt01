# 置き場所と接続先の設定。パスはここ1か所で決まる（環境変数で上書きできる）
import os
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent              # tools/sdgen
WORK = Path(os.environ.get('SDGEN_WORK', TOOLS / 'work'))     # 生成物・中間ファイル（git に入れない）
DOC_DIR = Path(os.environ.get('SDGEN_DOC_DIR', r'C:\myPrjt01\seikyuPrjt01'))   # 画面設計書の置き場所
SUPPLEMENT = Path(os.environ.get('SDGEN_SUPPLEMENT', TOOLS / '補足入力.xlsx'))  # 人が書く入力
SCREENS = TOOLS / 'screens.json'                              # 画面の開き方と取り出す区画
FIXED = TOOLS / 'fixed'                                       # 固定画像（補足入力の「図」で指定）
SCHEMA = TOOLS.parent.parent / 'test' / 'schema' / 'schema.sql'  # DB 定義（桁数の規則で使う）

# 画面を取り出すローカル検証サーバ（本番には接続しない）
BASE = os.environ.get('SDGEN_BASE', 'http://127.0.0.1:8098')
USER = os.environ.get('SDGEN_USER', 'doc-admin')


def password():
    """ローカル検証用のパスワード。SDGEN_PASSWORD か SDGEN_PASSWORD_FILE で渡す（リポジトリには置かない）"""
    if os.environ.get('SDGEN_PASSWORD'):
        return os.environ['SDGEN_PASSWORD']
    f = os.environ.get('SDGEN_PASSWORD_FILE')
    if f and Path(f).exists():
        return Path(f).read_text(encoding='utf-8-sig').strip()
    raise SystemExit('SDGEN_PASSWORD または SDGEN_PASSWORD_FILE を設定してください')


def chromium():
    """playwright の Chromium（setup.bat で入れたもの）。見つからなければ playwright の既定"""
    root = Path(os.environ.get('LOCALAPPDATA', '')) / 'ms-playwright'
    for d in sorted(root.glob('chromium-*'), reverse=True):
        exe = d / 'chrome-win64' / 'chrome.exe'
        if exe.exists():
            return str(exe)
    return None


def latest_doc():
    """設計書フォルダの最新版（seikyu-web_画面設計_YYYYMMDDVn.xlsx の V 番号が最大のもの）"""
    import re
    best = None
    for p in DOC_DIR.glob('seikyu-web_画面設計_*V*.xlsx'):
        m = re.search(r'_(\d{8})V(\d+)\.xlsx$', p.name)
        if m and not p.name.startswith('~$') and (best is None or int(m[2]) > best[0]):
            best = (int(m[2]), p)
    return best[1] if best else None
