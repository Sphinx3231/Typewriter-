#!/usr/bin/env python3
"""Regenerates src/humanize/slopmonster/parity.json: what SlopMonster's own deslop.py reports for
each input of parity-corpus.json. parity.test.ts then requires the TypeScript port to report
exactly the same.

    git clone https://github.com/ItsssssJack/SlopMonster /tmp/slopmonster
    python3 -I scripts/slopmonster-parity.py /tmp/slopmonster

Development only: nothing here ships in the app.
"""
import json
import os
import subprocess
import sys

upstream = os.path.abspath(sys.argv[1])
here = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'humanize', 'slopmonster')
sys.path.insert(0, os.path.join(upstream, 'tools'))
from deslop import audit, normalise  # noqa: E402

commit = subprocess.run(['git', '-C', upstream, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
with open(os.path.join(here, 'parity-corpus.json'), encoding='utf-8') as fh:
    corpus = json.load(fh)

cases = []
for text in corpus:
    hits = audit(normalise(text))
    cases.append({k: [list(x) if isinstance(x, tuple) else x for x in v] for k, v in hits.items()})

with open(os.path.join(here, 'parity.json'), 'w', encoding='utf-8') as fh:
    json.dump({'upstream': commit, 'cases': cases}, fh, ensure_ascii=False, indent=1)
    fh.write('\n')
print(f'{len(cases)} cases from {commit}')
