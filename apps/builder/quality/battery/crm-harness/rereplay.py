#!/usr/bin/env python3
# rereplay.py <test-dir>... — a check whose replay ended in ERROR (the harness, not the app: a boot
# killed, a port still busy) is replayed once more, and both outcomes are kept in battery.json.
import json, os, subprocess, sys
P = os.path.dirname(os.path.abspath(__file__))
for t in sys.argv[1:]:
    bp = os.path.join(t, 'out', 'battery.json')
    if not os.path.exists(bp):
        continue
    b = json.load(open(bp))
    for k, v in list(b.items()):
        if v['result'] != 'ERROR' or v.get('rereplayed'):
            continue
        env = {**os.environ, 'BATTERY_APP': os.environ.get('BATTERY_APP', 'crm'), 'OIDC_ISSUER': 'http://localhost:18800'}
        out = subprocess.run(['python3', 'battery/_harness.py', 'one', k, '19870'], cwd=os.path.join(t, 'app'), env=env, capture_output=True, text=True).stdout
        line = [l for l in out.splitlines() if l.startswith(k + ' ')]
        if line:
            _, verdict, *ev = line[-1].split(' ', 2)
            b[k] = {'result': verdict, 'evidence': (ev[0] if ev else '')[:300], 'rereplayed': True, 'first': v}
            print(os.path.basename(t), k, 'ERROR ->', verdict)
    json.dump(b, open(bp, 'w'), indent=1)
