#!/usr/bin/env python3
# compare-crm.py — each CRM calibration copy's replayed verdicts against the golden's: every check
# that differs, with the tester's evidence, so a reviewer can tell the planted hole's real reach
# from a tester's mistake. The golden's own verdicts were reviewed by hand (golden-crm/out).
# The golden and the tests are in $CHECKS_WORK/battery: golden-crm/{app,out}, tests/<copy>/out.
import json, os
P = os.path.dirname(os.path.abspath(__file__))
W = os.path.join(os.environ.get('CHECKS_WORK') or os.path.join(P, '..', '..', '..', '..', '..', '.builder', 'checks'), 'battery')
gold = json.load(open(os.path.join(W, 'golden-crm', 'out', 'battery.json')))
for line in open(os.path.join(P, 'crm-cal-map.txt')).read().split('\n'):
    if not line.strip():
        continue
    n, c = line.split()
    bp = os.path.join(W, 'tests', n, 'out', 'battery.json')
    if not os.path.exists(bp):
        print(f'{n} {c:20} not finished'); continue
    b = json.load(open(bp))
    diff = [k for k in gold if b.get(k, {}).get('result') != gold[k]['result']]
    print(f"{n} {c:20} differs from golden on {len(diff)}: " + (', '.join(f"{k} {gold[k]['result']}->{b.get(k, {}).get('result')}" for k in diff) or 'nothing'))
    for k in diff:
        print(f"    {k}: {b.get(k, {}).get('evidence', '')[:260]}")
