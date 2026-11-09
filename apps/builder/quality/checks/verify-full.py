# Real checks for a build from the brief: it names its own operations and cast, so this reads them from the
# project. Outcomes are judged, not status codes: did the person get the list or not.
#
#   python3 verify-full.py [<run-id>...]       archived runs, $BUILDER_RUNS/runs/<id>/project
#
# Each run is copied to $CHECKS_WORK/verify/<id> (its data in $CHECKS_WORK/verify-data/<id>) and borrows
# node_modules: with NM_HOME set, from the lane that built it, <LANE_ROOT>/.builder/projects/eval-<lane>-todo;
# otherwise, or when that lane has no install, from NM_FALLBACK (default <LANE_ROOT>/.builder/projects/eval-todo).
# LANE_ROOT is relative to the repo, and defaults to it.
import json, re, shutil, os, signal, subprocess, sys, time, urllib.error, urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..'))
D = os.environ.get('CHECKS_WORK') or os.path.join(REPO, '.builder', 'checks')
R = os.path.join(os.environ.get('BUILDER_RUNS') or os.path.join(REPO, 'data', 'builder-runs'), 'runs')
LANE_ROOT = os.path.normpath(os.path.join(REPO, os.environ.get('LANE_ROOT', '')))
NM_FALLBACK = os.environ.get('NM_FALLBACK') or os.path.join(LANE_ROOT, '.builder', 'projects', 'eval-todo')
ISS = 'http://localhost:8879'


def http(url, method='GET', body=None, token=None):
    h = {'content-type': 'application/json'}
    if token:
        h['authorization'] = 'Bearer ' + token
    r = urllib.request.Request(url, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(r, timeout=15) as x:
            t = x.read().decode()
            return x.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try:
            return e.code, json.loads(t)
        except Exception:
            return e.code, t[:160]


def up(url):
    try:
        urllib.request.urlopen(url, timeout=2)
        return True
    except urllib.error.HTTPError as e:
        return e.code < 500
    except Exception:
        return False


def surface(p):
    m = open(p + '/spec/model.ts').read()
    # Each operation's text runs to the next operation's key, whatever the build's indentation.
    keys = list(re.finditer(r"'([a-z][a-z0-9-]*/[a-z0-9-]+)'\s*:\s*\{", m))
    ops = {k.group(1): m[k.end():(keys[i + 1].start() if i + 1 < len(keys) else len(m))] for i, k in enumerate(keys)}
    names = {}
    # Two namespaces may share a short name (todo/cancel-invite beside workspace/cancel-invite):
    # the one beside create-list is the list's, which is what this harness drives.
    home = next((k.split('/')[0] for k in ops if k.endswith('/create-list')), None)
    for k in sorted(ops, key=lambda k: k.split('/')[0] == home):
        short = k.split('/')[1]
        names[short] = k
        # A build may call its items tasks: add-task is the add-item this harness drives.
        names.setdefault(short.replace('task', 'item'), k)
    field = lambda op, a, b: a if re.search(rf'\b{a}:', ops[names[op]].split('output')[0]) else b
    return names, field('create-list', 'name', 'title'), field('add-item', 'text', 'title')


def people(p):
    s = open(p + '/src/personas.ts').read()
    return re.findall(r"sub: '([^']+)'[^\n}]*?email: '([^']+)'", s)


def flow(api, names, name_field, text_field, cast):
    res = []

    def ok(label, good, detail=''):
        res.append((label, bool(good)))
        print(('PASS ' if good else 'FAIL ') + label, '' if good else str(detail)[:150], flush=True)

    tok = lambda sub: http(ISS + '/dev/token', 'POST', {'sub': sub})[1]['access_token']
    (o_sub, o_mail), (m_sub, m_mail) = cast[0], cast[1]
    T = {'owner': tok(o_sub), 'member': tok(m_sub)}
    inv = lambda who, op, inp=None: http(api + '/api/invoke', 'POST', {'op': names[op], 'input': inp or {}}, T[who])
    mine = lambda who: inv(who, 'my-lists')
    ok('anonymous is refused', http(api + '/api/invoke', 'POST', {'op': names['my-lists'], 'input': {}})[0] in (401, 403))
    s = inv('owner', 'join', {'email': o_mail, 'displayName': 'Owner'})
    ok('owner joins', s[0] in (200, 201), s)
    made = inv('owner', 'create-list', {name_field: 'Groceries'})
    ok('owner creates a list', made[0] in (200, 201), made)
    lid = made[1].get('id', '') if isinstance(made[1], dict) else ''
    item = inv('owner', 'add-item', {'listId': lid, text_field: 'Milk'})
    ok('owner adds an item', item[0] in (200, 201), item)
    iid = item[1].get('id', '') if isinstance(item[1], dict) else ''
    done = inv('owner', 'set-item-done', {'itemId': iid, 'done': True})
    ok('owner ticks it', done[0] in (200, 201), done)

    # the invite, and the attack on it: the member has never called the API, and no seed joined them
    mk = lambda n: (lambda r: r[1].get('id', '') if isinstance(r[1], dict) else '')(inv('owner', 'create-list', {name_field: n}))
    for_member, for_victim = mk('For the member'), mk('Private')
    invite = 'invite' if 'invite' in names else 'share-list'
    a = inv('owner', invite, {'listId': for_member, 'email': m_mail})
    ok('owner invites someone who has not joined', a[0] in (200, 201), a)
    b = inv('owner', invite, {'listId': for_victim, 'email': 'victim@example.com'})
    ok('owner invites a second address', b[0] in (200, 201), b)
    lister = 'list-invites' if 'list-invites' in names else 'list-invitations' if 'list-invitations' in names else None
    if lister:
        w = inv('owner', lister, {'listId': for_member})
        # A seed this harness could not keep from joining the member makes the invite a share at
        # once, which is right: there is nothing to wait for, so that case is not counted.
        sharer = 'list-shares' if 'list-shares' in names else None
        shared_now = bool(sharer) and m_mail in str(inv('owner', sharer, {'listId': for_member})[1]) and m_mail not in str(w[1])
        if shared_now:
            print('   note: the member was already joined by the seed, so the invite became a share (not counted)', flush=True)
        else:
            ok('the owner sees it waiting', w[0] == 200 and m_mail in str(w[1]), w)
    attack = inv('member', 'join', {'email': 'victim@example.com', 'displayName': 'Mallory'})
    print('attack: first join with a claimed address', attack[0], str(attack[1])[:100], flush=True)
    inv('member', 'join', {'email': m_mail, 'displayName': 'Member'})
    time.sleep(1.5)
    z = mine('member')
    hijacked = bool(for_victim) and for_victim in str(z[1])
    ok('attack: a claimed address receives nothing', not hijacked, 'HIJACKED ' + str(z[1])[:110])
    arrived = False
    for _ in range(16):
        if for_member in str(mine('member')[1]):
            arrived = True
            break
        time.sleep(.25)
    ok('the invited list arrives after joining', arrived, mine('member'))
    ok('the invited person reads its items', inv('member', 'list-items', {'listId': for_member})[0] == 200)
    if 'cancel-invite' in names:
        c = inv('owner', invite, {'listId': for_member, 'email': 'erin@example.com'})
        cid = (c[1].get('id') or c[1].get('invite_id') or c[1].get('inviteId') or '') if isinstance(c[1], dict) else ''
        # The input field is the build's to name (inviteId, invitationId): read it from its model.
        blk = re.search(rf"'{names['cancel-invite']}':\s*\{{.*?input:\s*z\.object\(\{{\s*(\w+)\s*:", open(p + '/spec/model.ts').read(), re.S)
        wd = inv('owner', 'cancel-invite', {(blk.group(1) if blk else 'inviteId'): cid})
        ok('the owner withdraws an invitation', wd[0] in (200, 201, 204), (wd[0], wd[1].get('detail') if isinstance(wd[1], dict) else wd[1]))

    # sharing with someone who has joined
    ok('an unshared list is invisible', lid not in str(mine('member')[1]))
    ok('a stranger is refused the items', inv('member', 'list-items', {'listId': lid})[0] in (403, 404))
    share_op = 'share-list' if 'share-list' in names else 'invite'
    shared = inv('owner', share_op, {'listId': lid, 'email': m_mail})
    ok('owner shares with a joined person', shared[0] in (200, 201), shared)
    arrived = False
    for _ in range(12):
        if lid in str(mine('member')[1]):
            arrived = True
            break
        time.sleep(.25)
    ok('the shared person sees the list', arrived)
    ok('the shared person reads the items', inv('member', 'list-items', {'listId': lid})[0] == 200)
    ok('the shared person adds an item', inv('member', 'add-item', {'listId': lid, text_field: 'Eggs'})[0] in (200, 201))
    ok('the shared person cannot delete the list', inv('member', 'delete-list', {'listId': lid})[0] in (403, 404))
    ok('the shared person cannot share onward', inv('member', share_op, {'listId': lid, 'email': 'x@example.com'})[0] in (403, 404))

    # revoke, last, by whatever id the build's own list of shares gives
    rows = inv('owner', 'list-shares', {'listId': lid})
    entries = rows[1].get('entries', rows[1]) if isinstance(rows[1], dict) else rows[1]
    sid = next((e.get('id') for e in entries or [] if isinstance(e, dict) and m_mail in str(e)), '')
    ok('owner sees who has access', rows[0] == 200 and bool(sid), rows)
    ok('owner revokes the share', inv('owner', 'revoke-share', {'shareId': sid})[0] in (200, 201, 204))
    ok('a revoked person is refused', inv('member', 'list-items', {'listId': lid})[0] in (403, 404))
    ok('owner deletes the list', inv('owner', 'delete-list', {'listId': lid})[0] in (200, 201, 204))
    print(sum(g for _, g in res), 'of', len(res), 'passed', flush=True)
    return hijacked


ids = sys.argv[1:] or sorted(d for d in os.listdir(R) if d.startswith('full-invites-'))
for rid in ids:
    src = f'{R}/{rid}/project'
    if not os.path.exists(src + '/src/server.ts') or not os.path.exists(src + '/src/personas.ts'):
        print(rid[-18:], 'no server to run')
        continue
    p = f'{D}/verify/{rid}'
    shutil.rmtree(p, ignore_errors=True)
    shutil.copytree(src, p, symlinks=True, ignore=shutil.ignore_patterns('node_modules', 'dist'))
    # A build can depend on what golden does not: its own lane's install has it, if that is still there.
    lane = re.search(r'-l(\d+)-', rid)
    home = f"{LANE_ROOT}/.builder/projects/eval-{lane.group(1)}-todo" if lane else ''
    deps = home if home and os.path.exists(home + '/node_modules') and 'NM_HOME' in os.environ else NM_FALLBACK
    os.symlink(deps + '/node_modules', p + '/node_modules')
    os.symlink(deps + '/app/node_modules', p + '/app/node_modules')
    cast = people(src)
    # A seed that joins everyone hides the join from the attack, which then only meets an existing row.
    # In the copy, this one person stays unjoined, so the attack is a real first join.
    seed = open(p + '/src/seed.ts').read()
    fresh = re.sub(r"(await \w+\.invoke\('[a-z]+/join', \{[^}]*?\b((?:\w+\.)*\w+)\.(?:email|name))", lambda m: f"if ({m.group(2)}.email !== '{cast[1][1]}') " + m.group(1), seed)
    print('seed patched' if fresh != seed else 'seed left as it is', flush=True)
    open(p + '/src/seed.ts', 'w').write(fresh)
    names, name_field, text_field = surface(p)
    wp = (re.findall(r'WEB_PORT\s*\?\?\s*(\d+)', open(p + '/app/vite.config.ts').read()) or ['5291'])[0]
    data = f'{D}/verify-data/{rid}'
    shutil.rmtree(data, ignore_errors=True)
    os.makedirs(data)
    env = {**os.environ, 'DATA_DIR': data}
    logs = open(p + '/serve.log', 'w')
    procs = [
        subprocess.Popen(c, cwd=w, env=env, stdout=logs, stderr=logs, start_new_session=True)
        for c, w in (
            (['./node_modules/.bin/substrat-dev-issuer', '--personas', 'src/personas.ts'], p),
            (['./node_modules/.bin/tsx', 'src/server.ts'], p),
            (['./node_modules/.bin/vite', '--strictPort'], p + '/app'),
        )
    ]
    api = f'http://localhost:{wp}'
    try:
        for _ in range(80):
            if up(api + '/api/me') and up(ISS + '/.well-known/openid-configuration'):
                break
            time.sleep(.5)
        else:
            print(rid[-18:], 'NEVER READY through the app proxy', flush=True)
            continue
        print('==', rid[-18:], 'cast', [c[0] for c in cast][:4], flush=True)
        import contextlib, io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            try:
                flow(api, names, name_field, text_field, cast)
            except Exception as e:
                print('ABORT', repr(e)[:200])
        txt = buf.getvalue()
        open(p + '/flow.log', 'w').write(txt)
        for line in txt.splitlines():
            if line.startswith(('FAIL', 'ABORT', 'attack:')) or ' passed' in line:
                print('  ', line[:165], flush=True)
    finally:
        for x in procs:
            try:
                os.killpg(x.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
        time.sleep(1.2)
        for x in procs:
            try:
                os.killpg(x.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        time.sleep(.5)
left = subprocess.run('lsof -nP -iTCP:8879 -iTCP:8891 -iTCP:5291 -sTCP:LISTEN | tail -n +2', shell=True, capture_output=True, text=True).stdout
print('still listening:', left[:200] or 'nothing')
print('FINISHED')
