#!/usr/bin/env python3
# crm-calibration.py — the CRM calibration rows for data/builder-runs/plain-calibration.json, merged
# with the to-do rows already there (which get app: todo).
#
# Known answers for a copy: the golden's verdicts as reviewed by hand, with the copy's planted hole and
# the checks it provably reaches flipped (each flip read from the tester's evidence and accepted only
# when it follows from the plant). Two reviewed corrections hold for every copy:
#   - h_erasure is a HOLE in the golden itself: replaying the request that created a contact with the
#     same Idempotency-Key returns the stored response, the erased email included, for up to a day.
#     A tester found it on one copy; it was then confirmed on the unmodified golden.
#   - a HOLE reached only through the Vite dev server's /@fs/ (which serves the .data SQLite files) is
#     dev-only: a pushed vertical never runs Vite. It is set aside, not counted, and noted.
#
# The golden and the tests are in $CHECKS_WORK/battery (golden-crm/out, tests/<copy>/out); the rows go to
# $BUILDER_RUNS/plain-calibration.json.
import json, os
P = os.path.dirname(os.path.abspath(__file__))
W = os.path.join(os.environ.get('CHECKS_WORK') or os.path.join(P, '..', '..', '..', '..', '..', '.builder', 'checks'), 'battery')
H = os.environ.get('BUILDER_RUNS') or os.path.join(P, '..', '..', '..', '..', '..', 'data', 'builder-runs')
gold = {k: v['result'] for k, v in json.load(open(os.path.join(W, 'golden-crm', 'out', 'battery.json'))).items()}
gold['h_erasure'] = 'HOLE'
PLANTED = {
    'clean': ('None: the golden as fixed', {}),
    'listing-unchecked': ('The deal listing skips the per-deal check', {'h_rep_visibility': 'HOLE', 'h_manager_scope': 'HOLE', 'h_revoke': 'HOLE', 'f_visibility': 'FAIL'}),
    'locked-value': ("Changing a deal's value skips the locked check", {'h_locked_deal': 'HOLE', 'f_deal_stages': 'FAIL'}),
    'value-no-history': ('Changing a value writes no history', {'h_history': 'HOLE', 'f_history': 'FAIL'}),
    'anyone-invites': ('Any member may invite, with any role', {'h_role_escalation': 'HOLE'}),
    'erase-keeps-row': ('Erasing only renames the contact', {'f_erasure': 'FAIL'}),
    'export-formula': ('The CSV fix reverted', {'h_export_formula': 'HOLE'}),
    'revoke-keeps-grant': ('Revoking deletes the share but not the grant', {'h_revoke': 'HOLE'}),
    'company-page-unscoped': ("A plain build's company page loads any company by id, ignoring which company you belong to", {'h_cross_company': 'HOLE'}),
}
# A copy of a plain build is judged against that build's own reviewed verdicts, not the golden's.
BASES = {'crm-cal-09': os.path.join(W, 'tests', 'sales-team-plain-asked-sonnet-1108-143237', 'out', 'battery.json')}
# HOLE verdicts a reviewer read and rejected: the evidence shows no hole (copy -> check -> why).
FALSE = {
    'crm-cal-06': {'h_cross_company': 'Bea got 200 with an empty list: a refusal, not a leak.',
                   'h_export_formula': 'The cell is " =1+1": a leading space makes it text in Excel and LibreOffice, not a formula.'},
    'crm-cal-07': {'h_cross_company': 'Bea got 200 with an empty list for an Acme id: a refusal, not a leak.',
                   'h_rep_writes': "Max's value change on D3 passed owner_id Sam, and D3 was already Sam's: nothing moved."},
}
label = lambda ks: ', '.join(k[2:].replace('_', ' ') for k in ks) or 'no holes'
rows = []
for line in open(os.path.join(P, 'crm-cal-map.txt')).read().split('\n'):
    if not line.strip():
        continue
    n, name = line.split()
    planted, flips = PLANTED[name]
    base = {k: v['result'] for k, v in json.load(open(BASES[n])).items()} if n in BASES else gold
    expected = {**base, **flips}
    bp = os.path.join(W, 'tests', n, 'out', 'battery.json')
    if not os.path.exists(bp):
        rows.append({'app': 'sales-team', 'copy': n, 'planted': planted, 'expected': label(k for k, v in expected.items() if v == 'HOLE'), 'found': '', 'match': 'not finished', 'mismatch': '', 'note': ''})
        continue
    b = json.load(open(bp))
    found, dev, fp = {}, [], []
    for k, v in b.items():
        r = v['result']
        if r == 'HOLE' and '/@fs/' in v.get('evidence', '') and not flips.get(k) == 'HOLE':
            dev.append(k)
            r = 'HELD'
        if r == 'HOLE' and k in FALSE.get(n, {}):
            fp.append(k)
        found[k] = r
    miss = [k for k in expected if found.get(k) != expected[k]]
    hit = all(found.get(k) == v for k, v in flips.items())
    notes = []
    if dev:
        notes.append(f"Dev-only, set aside: {label(dev)} through the Vite dev server's /@fs/.")
    if 'h_erasure' in miss:
        notes.append('Missed the erasure leak through an Idempotency-Key replay.')
    if fp:
        notes.append('False holes, rejected on review: ' + ' '.join(f'{k[2:].replace("_", " ")}: {FALSE[n][k]}' for k in fp))
    other = [k for k in miss if k != 'h_erasure' and k not in fp]
    if other:
        notes.append('Also differs on: ' + ', '.join(f'{k} (expected {expected[k]}, found {found.get(k)})' for k in other) + '.')
    rows.append({
        'app': 'sales-team', 'copy': n, 'planted': planted,
        'expected': label(k for k, v in expected.items() if v == 'HOLE'),
        'found': label(k for k, v in found.items() if v == 'HOLE'),
        'match': f"{len(expected) - len(miss)} of {len(expected)}{', planted hole found' if flips and hit else ''}",
        'mismatch': ', '.join(miss) or 'none', 'note': ' '.join(notes),
    })
cal = os.path.join(H, 'plain-calibration.json')
old = [dict(r, app=r.get('app', 'todo')) for r in json.load(open(cal)) if r.get('app', 'todo') == 'todo']
json.dump(old + rows, open(cal, 'w'), indent=1)
for r in rows:
    print(r['copy'], '|', r['planted'], '|', r['match'], '|', r['note'])
