# -*- coding: utf-8 -*-
"""assets/prompts/*.txt -> assets/career-prompts.js 생성기.

앱 자체는 빌드가 필요 없다. 이 스크립트는 프롬프트 원문(.txt)을 고칠 때만
한 번 돌려서 생성 파일을 갱신하는 용도다.

    python tools/build-prompts.py
"""
import io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'prompts')
OUT = os.path.join(ROOT, 'assets', 'career-prompts.js')

FILES = {
    'first':      'prompt-1st.txt',
    'second':     'prompt-2nd.txt',
    'inputFirst': 'input-1st.txt',
    'inputSecond':'input-2nd.txt',
}

def read(name):
    with io.open(os.path.join(SRC, name), encoding='utf-8') as f:
        return f.read().replace('\r\n', '\n').lstrip('﻿')

data = {k: read(v) for k, v in FILES.items()}

body = [
    '/* 이 파일은 자동 생성된다 — 직접 고치지 말 것.',
    '   원문: assets/prompts/*.txt   재생성: python tools/build-prompts.py */',
    '(function (g) {',
    "    'use strict';",
    '    g.CareerPrompts = {',
]
for k in ('first', 'second', 'inputFirst', 'inputSecond'):
    body.append('        %s: %s,' % (k, json.dumps(data[k], ensure_ascii=False)))
body.append('        source: {')
for k, v in FILES.items():
    body.append('            %s: %s,' % (k, json.dumps('assets/prompts/' + v)))
body.append('        }')
body.append('    };')
body.append("})(typeof window !== 'undefined' ? window : this);")

with io.open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    f.write('\n'.join(body) + '\n')

print('generated %s (%d bytes)' % (OUT, os.path.getsize(OUT)))
for k in FILES:
    print('  %-12s %6d chars' % (k, len(data[k])))
