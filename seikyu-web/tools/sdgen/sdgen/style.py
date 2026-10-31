# 設計書の見た目の規則（V15 の書式に合わせる）。色・文字・罫線・列幅はここだけで決める
import math
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

FONT = 'Meiryo UI'
NAVY, GRAY, BLUE = '1E2761', '5A6478', '0563C1'
FILL = {'head': 'CADCFC', 'area': 'EEF3FC', 'input': 'DDEBF7', 'req': 'FCE4D6', 'meta': 'F2F2F2'}
WIDTH = {'A': 18, 'B': 30, 'C': 10, 'D': 8, 'E': 20, 'F': 10, 'G': 8, 'H': 12, 'I': 16, 'J': 20, 'K': 44}
CUSTOMER, SYSTEM, DOCNAME = '中部土木　様', 'APLink 請求・入金管理システム', '画面仕様'
_thin = Side(style='thin', color='BFBFBF')
BOX = Border(left=_thin, right=_thin, top=_thin, bottom=_thin)


def font(size=9, bold=False, color='000000', underline=None):
    return Font(name=FONT, size=size, bold=bold, color=color, underline=underline)


def fill(key):
    return PatternFill('solid', fgColor=FILL[key])


TOP = Alignment(vertical='top', wrap_text=True)
CENTER = Alignment(horizontal='center', vertical='center', wrap_text=True)


def width_units(text):
    """セルに入る文字の幅（全角＝2、半角＝1）"""
    return sum(2 if ord(ch) > 255 else 1 for ch in str(text))


def height(texts_widths, base=15.0, line=12.5):
    """折り返しを見込んだ行の高さ。texts_widths＝[(文字列, 列幅の合計)]"""
    lines = 1
    for t, w in texts_widths:
        lines = max(lines, sum(max(1, math.ceil(width_units(p) * 1.05 / max(w - 1, 1))) for p in str(t or '').split('\n')))
    return max(base, round(lines * line + 3, 1))
