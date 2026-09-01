# -*- coding: utf-8 -*-
"""저장된 진로상담 보고서(md)가 끝까지 나왔는지 검사한다.

배경: 2026-09-01 세션에서 "보고서 끝단이 잘려 나가는" 결함이 네 번 재발했다
(STEP 11 최종 브리프·면책 문장 누락). 매번 사람이 눈으로 확인했고, 그래서
매번 늦게 발견됐다. 그 확인을 명령으로 바꾼 것이다.

    python tools/check-report.py <보고서.md> [보고서2.md ...]
    python tools/check-report.py --kind 2 report.md   # 종류 자동판별을 덮어씀

종료 코드 0 = 통과, 1 = 실패.
"""
import io, os, re, sys

# ---------------------------------------------------------------- 기대 형식
# 1차: 최종 출력이 A~L 섹션 + 출처 구분 3개 + 면책 한 문장으로 끝난다.
# 2차: STEP 1~11 + 면책 한 문장으로 끝난다.
FIRST_SECTIONS = list('ABCDEFGHIJKL')
FIRST_TAIL_HEADS = [
    '현재 공식자료로 확인된 내용',
    '현재 확인할 수 없는 내용',
    '상담에서의 해석',
]
FIRST_DISCLAIMER = '본 자료는 진로상담을 시작하기 위한 1차 정보이며'

SECOND_STEPS = list(range(1, 12))
SECOND_DISCLAIMER = '본 2차 분석은 1차 진로리서치에서'

# 모의 응답이 볼트·파일로 새어 나간 사고가 실제로 있었다(2026-09-01, f2abc97).
MOCK_MARK = '모의 응답'

# 인코딩 사고로 생기는 대체문자(U+FFFD). 소스에 직접 쓰지 않는다 —
# init.ps1 의 인코딩 검사가 이 파일 자체를 깨진 파일로 찍는다.
BROKEN_CHAR = chr(0xFFFD)

TAIL_WINDOW = 25  # 면책 문장은 문서 끝부분에 있어야 한다


def fail(msg):
    print(u'    [FAIL] ' + msg)


def ok(msg):
    print(u'    [OK]   ' + msg)


def note(msg):
    print(u'    ' + msg)


def detect_kind(text):
    # 잘린 문서일수록 종류 판별이 중요하다 — 그래야 "무엇이 빠졌는지"를 말해 줄 수 있다.
    # 1차 출력에는 STEP 표제가 없고(A~L 섹션), 2차 출력은 STEP 표제로만 이뤄진다.
    if SECOND_DISCLAIMER in text or re.search(r'(?m)^#{1,3}\s*STEP\s*\d+\b', text):
        return 2
    if FIRST_DISCLAIMER in text or len(re.findall(r'(?m)^#{1,3}\s*[A-L]\.', text)) >= 3:
        return 1
    return 0


def check(path, kind=None):
    if not os.path.isfile(path):
        fail(u'파일이 없다: %s' % path)
        return False

    with io.open(path, encoding='utf-8', errors='replace') as f:
        text = f.read().replace('\r\n', '\n').lstrip(u'﻿')

    if BROKEN_CHAR in text:
        fail(u'%s — 깨진 문자가 있다(인코딩 사고)' % os.path.basename(path))
        return False

    k = kind or detect_kind(text)
    if k == 0:
        fail(u'%s — 1차/2차 어느 쪽인지 판별되지 않는다 (양쪽 마커 모두 없음: 통째로 잘렸을 수 있다)'
             % os.path.basename(path))
        return False

    print(u'==> %s  (%d차로 판별, %d자)' % (os.path.basename(path), k, len(text)))
    bad = 0

    if MOCK_MARK in text:
        fail(u'모의 응답이다 — 실제 분석 결과가 아니다. 상담자료로 쓰지 말 것')
        bad += 1

    if k == 1:
        missing = [s for s in FIRST_SECTIONS
                   if not re.search(r'(?m)^#{1,3}\s*%s\.' % s, text)]
        if missing:
            fail(u'섹션 누락: %s' % u', '.join(missing))
            bad += 1
        else:
            ok(u'A~L 섹션 12개 모두 존재')

        miss_tail = [h for h in FIRST_TAIL_HEADS if h not in text]
        if miss_tail:
            fail(u'출처 구분 소제목 누락: %s' % u', '.join(miss_tail))
            bad += 1
        else:
            ok(u'출처 구분 소제목 3개 존재')

        disclaimer = FIRST_DISCLAIMER
    else:
        missing = [u'STEP %d' % n for n in SECOND_STEPS
                   if not re.search(r'(?m)^#{1,3}\s*STEP\s*%d\b' % n, text)]
        if missing:
            fail(u'단계 누락: %s' % u', '.join(missing))
            bad += 1
        else:
            ok(u'STEP 1~11 모두 존재')

        disclaimer = SECOND_DISCLAIMER

    # 면책 문장이 "있는가" 만으로는 부족하다 — 끝에 있어야 끝까지 나온 것이다.
    lines = [l for l in text.split('\n') if l.strip()]
    if disclaimer not in text:
        fail(u'면책 문장이 없다 — 응답이 잘렸다')
        bad += 1
    elif not any(disclaimer in l for l in lines[-TAIL_WINDOW:]):
        fail(u'면책 문장이 본문 중간에 있다 — 뒤쪽이 잘렸거나 이어쓰기가 어긋났다')
        bad += 1
    else:
        ok(u'면책 문장이 문서 끝에 있음')

    if len(text) < 3000:
        fail(u'본문이 너무 짧다 (%d자) — 정상 보고서는 수만 자다' % len(text))
        bad += 1

    if bad == 0:
        ok(u'통과')
    return bad == 0


def main(argv):
    kind = None
    paths = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--kind':
            i += 1
            kind = int(argv[i])
        else:
            paths.append(a)
        i += 1

    if not paths:
        print(__doc__)
        return 2

    results = [check(p, kind) for p in paths]
    print('')
    if all(results):
        print(u'==> 보고서 %d건 전부 통과' % len(results))
        return 0
    print(u'==> 실패 %d건 / %d건' % (results.count(False), len(results)))
    return 1


if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(encoding='utf-8')  # py3.7+
    except Exception:
        pass
    sys.exit(main(sys.argv[1:]))
