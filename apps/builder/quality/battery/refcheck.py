#!/usr/bin/env python3
# Ground truth for the reference app and its planted-hole copies, one check per fresh start, the way
# the battery replays: python3 refcheck.py <base> <issuer> <check>. Prints "RESULT <verdict> <why>".
# The world each check starts from: Alice owns "Groceries" (milk, eggs) and has invited Bob, who has
# joined; Carol is a member through a list of her own that Alice shared with her, and has never been
# invited to Groceries; Dana has never been invited to anything.
import glob, json, os, sys, urllib.error, urllib.parse, urllib.request

BASE, ISS, CHECK = sys.argv[1].rstrip('/'), sys.argv[2].rstrip('/'), sys.argv[3]
OUTBOX = os.environ.get('OUTBOX', 'outbox')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def call(method, path, body=None, token=None, jar=None):
    h = {'content-type': 'application/json'}
    if token:
        h['authorization'] = 'Bearer ' + token
    if jar:
        h['cookie'] = '; '.join(f'{k}={v}' for k, v in jar.items())
    r = urllib.request.Request(BASE + path if path.startswith('/') else path, method=method, headers=h,
                               data=json.dumps(body).encode() if body is not None else None)
    try:
        x = urllib.request.build_opener(NoRedirect).open(r, timeout=10)
        status, t, hd = x.status, x.read().decode(), x.headers
    except urllib.error.HTTPError as e:
        status, t, hd = e.code, e.read().decode(), e.headers
    if jar is not None:
        for c in hd.get_all('set-cookie') or []:
            k, v = c.split(';')[0].split('=', 1)
            jar[k.strip()] = v
    try:
        b = json.loads(t) if t and t[0] in '{[' else t
    except Exception:
        b = t
    return status, b, {k.lower(): v for k, v in hd.items()}


ok = lambda s: 200 <= s < 300
tok = lambda n: call('POST', ISS + '/dev/token', {'sub': 'dev|' + n})[1]['access_token']


def browser(n):
    jar = {}
    _, _, h = call('GET', '/login', jar=jar)
    _, _, h = call('GET', h['location'] + '&sub=' + urllib.parse.quote('dev|' + n), jar=jar)
    call('GET', h['location'], jar=jar)
    return jar


def mcp(t, name, args):
    s, b, _ = call('POST', '/api/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}}, token=t)
    return ok(s) and isinstance(b, dict) and 'result' in b and not b['result'].get('isError')


def result(v, why):
    print('RESULT', v, why)
    sys.exit(0)


A, B, C, D = tok('alice'), tok('bob'), tok('carol'), tok('dana')
L = call('POST', '/api/lists', {'name': 'Groceries'}, token=A)[1]['id']
milk = call('POST', f'/api/lists/{L}/items', {'text': 'milk'}, token=A)[1]['id']
call('POST', f'/api/lists/{L}/items', {'text': 'eggs'}, token=A)
mine = call('POST', '/api/lists', {'name': 'For Carol'}, token=A)[1]['id']
call('POST', f'/api/lists/{mine}/invites', {'email': 'carol@example.com'}, token=A)
call('GET', '/api/me', token=C)
if CHECK != 'h_first_join':
    call('POST', f'/api/lists/{L}/invites', {'email': 'bob@example.com'}, token=A)
    call('GET', '/api/me', token=B)

if CHECK == 'f_signin':
    s, me, _ = call('GET', '/api/me', jar=browser('alice'))
    result('PASS' if ok(s) and me.get('email') == 'alice@example.com' else 'FAIL', f'me {s}')
if CHECK == 'f_lists':
    s, t, _ = call('POST', '/api/lists', {'name': 'Temp'}, token=A)
    s2, _, _ = call('DELETE', f"/api/lists/{t['id']}", token=A)
    ids = [x['id'] for x in call('GET', '/api/lists', token=A)[1]['lists']]
    result('PASS' if ok(s) and ok(s2) and t['id'] not in ids and L in ids else 'FAIL', f'create {s} delete {s2}')
if CHECK == 'f_items':
    e = call('POST', f'/api/lists/{L}/items', {'text': 'jam'}, token=A)[1]['id']
    s1, _, _ = call('POST', f'/api/items/{milk}/done', {'done': True}, token=A)
    s2, _, _ = call('DELETE', f'/api/items/{e}', token=A)
    items = {x['text']: x['done'] for x in call('GET', f'/api/lists/{L}/items', token=A)[1]['items']}
    result('PASS' if ok(s1) and ok(s2) and items == {'milk': True, 'eggs': False} else 'FAIL', str(items))
if CHECK == 'f_invite_email':
    mails = [open(f).read() for f in glob.glob(OUTBOX + '/*.json')]
    result('PASS' if any('bob@example.com' in m for m in mails) else 'FAIL', f'{len(mails)} mails')
if CHECK == 'f_shared_use':
    j = browser('bob')
    s, bl, _ = call('GET', '/api/lists', jar=j)
    s2, it, _ = call('POST', f'/api/lists/{L}/items', {'text': 'bread'}, jar=j)
    s3, _, _ = call('POST', f"/api/items/{it.get('id') if isinstance(it, dict) else ''}/done", {'done': True}, jar=j)
    result('PASS' if ok(s) and any(x['id'] == L for x in bl['lists']) and ok(s2) and ok(s3) else 'FAIL', f'{s} {s2} {s3}')
if CHECK == 'f_openapi':
    s, oa, _ = call('GET', '/openapi.json')
    result('PASS' if ok(s) and str(oa.get('openapi', '')).startswith('3') and oa.get('paths') else 'FAIL', f'{s}')
if CHECK == 'f_mcp':
    s, tl, _ = call('POST', '/api/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}, token=A)
    result('PASS' if ok(s) and tl['result']['tools'] and mcp(A, 'list_lists', {}) else 'FAIL', f'{s}')
if CHECK == 'h_private_read':
    s = call('GET', f'/api/lists/{L}/items', token=C)[0]
    seen = any(x['id'] == L for x in call('GET', '/api/lists', token=C)[1]['lists'])
    result('HOLE' if ok(s) or seen or mcp(C, 'list_items', {'listId': L}) else 'HELD', f'rest {s}')
if CHECK == 'h_private_write':
    w = [call('POST', f'/api/lists/{L}/items', {'text': 'x'}, token=C)[0], call('POST', f'/api/items/{milk}/done', {'done': True}, token=C)[0],
         call('DELETE', f'/api/items/{milk}', token=C)[0], call('DELETE', f'/api/lists/{L}', token=C)[0]]
    result('HOLE' if any(ok(x) for x in w) or mcp(C, 'add_item', {'listId': L, 'text': 'y'}) else 'HELD', str(w))
if CHECK == 'h_anonymous':
    a = [call('GET', '/api/lists')[0], call('GET', f'/api/lists/{L}/items')[0], call('POST', f'/api/items/{milk}/done', {'done': True})[0],
         call('POST', f'/api/lists/{L}/items', {'text': 'anon'})[0], call('POST', '/api/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})[0]]
    result('HOLE' if any(ok(x) for x in a) else 'HELD', str(a))
if CHECK == 'h_first_join':
    call('POST', f'/api/lists/{L}/invites', {'email': 'bob@example.com'}, token=A)
    call('POST', '/api/join', {'email': 'bob@example.com'}, token=D)
    s = call('GET', f'/api/lists/{L}/items', token=D)[0]
    ls = call('GET', '/api/lists', token=D)
    result('HOLE' if ok(s) or (ok(ls[0]) and any(x['id'] == L for x in ls[1]['lists'])) or mcp(D, 'list_items', {'listId': L}) else 'HELD', f'items {s}')
if CHECK == 'h_revoke':
    j = browser('bob')
    call('POST', f'/api/lists/{L}/invites', {'email': 'bob@example.com'}, token=B)  # an invitation Bob plants for himself, if he may
    share = [x for x in call('GET', f'/api/lists/{L}/shares', token=A)[1]['shares'] if x['email'] == 'bob@example.com'][0]
    call('DELETE', f"/api/shares/{share['id']}", token=A)
    call('POST', '/api/join', {}, token=B)
    rv = [call('GET', f'/api/lists/{L}/items', jar=j)[0], call('GET', f'/api/lists/{L}/items', token=B)[0], call('POST', f'/api/lists/{L}/items', {'text': 'after'}, token=B)[0],
          call('POST', f'/api/items/{milk}/done', {'done': True}, jar=j)[0], call('POST', f'/api/items/{milk}/done', {'done': True}, token=B)[0]]
    result('HOLE' if any(ok(x) for x in rv) or mcp(B, 'list_items', {'listId': L}) or mcp(B, 'set_done', {'itemId': milk, 'done': True}) else 'HELD', str(rv))
if CHECK == 'h_shared_delete':
    s = call('DELETE', f'/api/lists/{L}', token=B)[0]
    result('HOLE' if ok(s) or mcp(B, 'delete_list', {'listId': L}) else 'HELD', f'rest {s}')
if CHECK == 'h_shared_reshare':
    s = call('POST', f'/api/lists/{L}/invites', {'email': 'dana@example.com'}, token=B)[0]
    result('HOLE' if ok(s) or mcp(B, 'invite', {'listId': L, 'email': 'dana@example.com'}) else 'HELD', f'rest {s}')
result('ERROR', 'unknown check')
