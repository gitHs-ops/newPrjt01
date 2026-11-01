# 画面シートの差分（前の版 → 今回作ったもの）。部品（sheet.parse）どうしで比べ、変更点の文にする
import difflib, hashlib, io
from PIL import Image, ImageChops, ImageStat
from sdgen.sheet import parse

ITEM_COLS = ['エリア', '区分', '必須', '初期値', '桁数', '少数', '形式', '参照元テーブル', '参照元項目', '備考']


def _keyed(rows, key):
    """同じキーが2回以上あれば 2 番目から（2）…を付ける"""
    out, seen = {}, {}
    for r in rows:
        k = key(r); seen[k] = seen.get(k, 0) + 1
        out[k if seen[k] == 1 else (*k, seen[k])] = r
    return out


def model(ws, imgs):
    """シート → 比べる形。imgs＝図の画像（bytes、上から）"""
    d = parse(ws, ws.title)
    return {'items': _keyed(d['項目'], lambda r: (r['区画ID'], r['項目名称'])),
            'tables': _keyed([t for t in d['表'] if t['左'] or t['右']], lambda t: (t['左'],)),
            'texts': [b['文字'] for b in d['構成'] if b['種類'] in ('見出し大', '見出し中', '文', '項目', '手順')],
            'steps': _keyed(d['手順'], lambda x: (x['区画ID'], x['手順'])),
            'imgs': imgs}


def same_image(a, b):
    if hashlib.md5(a).digest() == hashlib.md5(b).digest(): return True
    x, y = Image.open(io.BytesIO(a)).convert('L'), Image.open(io.BytesIO(b)).convert('L')
    if abs(x.width / x.height - y.width / y.height) > 0.02: return False
    x, y = x.resize((48, 48)), y.resize((48, 48))
    return ImageStat.Stat(ImageChops.difference(x, y)).mean[0] < 4


def names(xs, n=4):
    return '、'.join(map(str, xs[:n])) + (f' ほか {len(xs) - n}' if len(xs) > n else '')


def _dict_diff(a, b, cols):
    add = [k for k in b if k not in a]; rem = [k for k in a if k not in b]
    chg = [k for k in b if k in a and any(str(a[k].get(c, '')) != str(b[k].get(c, '')) for c in cols)]
    return add, rem, chg


def diff(old, new):
    """→ (変更内容の文, シートの扱い)。違いが無ければ ('', '')"""
    parts, tags = [], []

    def say(title, add, rem, chg, tag, label):
        x = [f'{w} {len(k)}（{names([label(y) for y in k])}）' for w, k in (('追加', add), ('削除', rem), ('変更', chg)) if k]
        if x: parts.append(f'{title}：' + '／'.join(x)); tags.append(tag)

    say('画面項目', *_dict_diff(old['items'], new['items'], ITEM_COLS), '画面項目更新', lambda k: k[1])
    say('基本情報・説明', *_dict_diff(old['tables'], new['tables'], ['右']), '仕様更新', lambda k: k[0])
    say('操作手順', *_dict_diff(old['steps'], new['steps'], ['利用者の操作', '内容', '画面の反応', '備考']), '仕様更新', lambda k: f'{k[0]} 手順{k[1]}')
    sm = difflib.SequenceMatcher(None, old['texts'], new['texts'])
    add = [t for op, _, _, j1, j2 in sm.get_opcodes() if op in ('insert', 'replace') for t in new['texts'][j1:j2]]
    rem = [t for op, i1, i2, _, _ in sm.get_opcodes() if op in ('delete', 'replace') for t in old['texts'][i1:i2]]
    if add or rem: parts.append(f'見出し・文：追加 {len(add)}／削除 {len(rem)}（{names([t[:20] for t in add or rem], 2)}）'); tags.append('仕様更新')
    left, new_only = list(old['imgs']), []   # 並びは見ない（横に並んだ図は上下の順が決まらない）
    for i, b in enumerate(new['imgs']):
        j = next((j for j, a in enumerate(left) if same_image(a, b)), None)
        if j is None: new_only.append(f'図{i + 1}')
        else: left.pop(j)
    swap = min(len(new_only), len(left))
    figs = [f'{w} {n}' for w, n in (('差替え', swap), ('追加', len(new_only) - swap), ('削除', len(left) - swap)) if n > 0]
    if new_only: figs[0] += f'（{names(new_only)}）'
    if figs: parts.append('画面図：' + '／'.join(figs)); tags.append('画面図差替え')
    return '。'.join(parts), '・'.join(dict.fromkeys(tags))
