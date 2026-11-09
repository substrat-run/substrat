#!/usr/bin/env python3
# compare.py — each calibration copy's replayed verdicts against its ground truth.
# The truth is cal/<name>.truth.json here; the replays are $CHECKS_WORK/battery/tests/<copy>/out.
import json, os, sys
P = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(os.environ.get('CHECKS_WORK') or os.path.join(P, '..', '..', '..', '..', '.builder', 'checks'), 'battery', 'tests')
rows = []
for line in open(os.path.join(P, 'cal-map.txt')).read().split('\n'):
    if not line.strip():
        continue
    n, c = line.split()
    tp, bp = os.path.join(P, 'cal', c + '.truth.json'), os.path.join(T, n, 'out', 'battery.json')
    if not os.path.exists(bp):
        print(f'{n} {c:20} not finished'); continue
    t, b = json.load(open(tp)), json.load(open(bp))
    mism = [f"{k}: truth {t[k]['result']}, tester {b.get(k, {}).get('result')}" for k in t if b.get(k, {}).get('result') != t[k]['result']]
    ui = b.get('f_ui', {}).get('result')
    rows.append({'copy': n, 'name': c, 'match': f'{len(t) - len(mism)} of {len(t)}', 'mismatch': mism, 'ui': ui})
    print(f"{n} {c:20} {len(t) - len(mism)}/{len(t)} f_ui={ui} " + ('; '.join(mism) or 'exact'))
    den = json.load(open(os.path.join(T, n, 'out', 'report.json')))['results'][0].get('denied') or []
    for d in den: print('     denied:', d['what'][:110].replace('\n', ' | '), '=>', d['why'][:40])
    if os.path.exists(os.path.join(T, n, 'out', 'tampered.diff')): print('     TAMPERED')
