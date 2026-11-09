#!/usr/bin/env python3
"""
verify-hosted.py -- does a generated Substrat vertical work AS DEPLOYED?

The dev server (src/server.ts) joins people and grants them their own record itself, so a check
that drives it cannot see whether the deployed worker does. This harness runs the vertical's own
`substrat.runtimeNeeds.entry` (src/worker.ts) under `wrangler dev --local`, provisions and
configures it the way the platform does (/internal/provision, then /internal/configure with the
`substrat:auth` issuer choice), and signs a person in through a real OIDC round trip against the
project's dev issuer, the way a browser would: /api/auth/login -> issuer /authorize -> pick a
persona -> /api/auth/callback, cookies kept. Then /api/me, the create-list operation and the
list-reading operation, through POST /api/invoke.

    python3 verify-hosted.py <project-dir> [--node-modules <dir>] [--expect ok|refused]

The project is never modified: it is copied to a fresh work dir under
$CHECKS_WORK/verify-hosted/ (default <repo>/.builder/checks), and its node_modules are linked in entry by entry (so wrangler's
cache and state land in the copy, not in the original). Only the process groups this script
starts are stopped, and the ports are checked free afterwards.

Exit code: 0 when the outcome matches --expect (`ok`, the default: create-list succeeds and the
list-reading operation shows the new list; `refused`: create-list is refused), 1 when it does
not, 2 when the harness itself could not run (setup, boot or provisioning failure).
python3 stdlib only; node comes from PATH, or from `zsh -ic` when PATH has none.
"""
import argparse
import datetime
import html
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..'))
DEFAULT_WORK_ROOT = os.path.join(os.environ.get('CHECKS_WORK') or os.path.join(REPO, '.builder', 'checks'), 'verify-hosted')
# Ports other sessions use: the demo block, the template's, Vite's and Wrangler's defaults.
FORBIDDEN_PORTS = {5173, 8787, 8879, 8880, 8891, 5280, 9229} | set(range(8870, 8880)) | set(range(5270, 5280))
PLATFORM_HEADER = 'x-substrat-platform'  # contracts/wire-headers
AUTH_CONFIG_KEY = 'substrat:auth'  # vertical-auth instance-auth AUTH_CONFIG_KEY
SHARED_ISSUER_KEY = 'substrat:auth:shared-issuer'  # contracts SHARED_ISSUER_CONFIG_KEY
RUNTIME_BASELINE = '2026-06-01'  # contracts deploy.ts: the compatibility date a push derives
# The template's fixed dev node, used when src/worker.ts cannot be read for one.
TEMPLATE_DEV_NODE = ('01JZ00000000000000000DEV01', '01JZ00000000000000000DEV02')

PROCS = []  # (name, Popen, log path)


def log(msg=''):
    print(msg, flush=True)


def die(msg):
    log(f'HARNESS-ERROR {msg}')
    raise SystemExit(2)


# ── small utilities ───────────────────────────────────────────────────────────────────────────

B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'


def ulid():
    n = (int(time.time() * 1000) << 80) | int.from_bytes(os.urandom(10), 'big')
    return ''.join(B32[(n >> (5 * i)) & 31] for i in reversed(range(26)))


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def port_in_use(port):
    for family, addr in ((socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(0.3)
                if s.connect_ex((addr, port)) == 0:
                    return True
        except OSError:
            pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            # As the servers bind: a port a just-stopped run left in TIME_WAIT is free to them.
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(('127.0.0.1', port))
    except OSError:
        return True
    return False


def pick_port(wanted, taken, explicit):
    if wanted in FORBIDDEN_PORTS:
        die(f'port {wanted} is one other sessions use; pick another')
    if not port_in_use(wanted) and wanted not in taken:
        return wanted
    if explicit:
        die(f'port {wanted} is in use (lsof -nP -iTCP:{wanted} -sTCP:LISTEN)')
    p = wanted + 1
    while p < wanted + 200:
        if p not in FORBIDDEN_PORTS and p not in taken and not port_in_use(p):
            return p
        p += 1
    die(f'no free port near {wanted}')


def node_env():
    """The environment node and the project's bins run in: PATH from zsh -ic when node is not on it."""
    env = dict(os.environ)
    if not shutil.which('node', path=env.get('PATH')):
        out = subprocess.run(['zsh', '-ic', 'printf "\\n__PATH__%s\\n" "$PATH"'], capture_output=True, text=True, timeout=60).stdout
        line = [l for l in out.splitlines() if l.startswith('__PATH__')]
        if line:
            env['PATH'] = line[-1][len('__PATH__'):]
    if not shutil.which('node', path=env.get('PATH')):
        die('node is not on PATH, even from `zsh -ic`')
    # Nothing outward: no telemetry, no interactive prompts.
    env['WRANGLER_SEND_METRICS'] = 'false'
    env['CI'] = 'true'
    env.pop('NODE_OPTIONS', None)
    return env


def brief(body, limit=220):
    if body is None:
        return ''
    if isinstance(body, (dict, list)):
        if isinstance(body, dict) and ('detail' in body or 'title' in body or 'error' in body):
            code = body.get('code') or body.get('title') or ''
            detail = body.get('detail') or body.get('error') or body.get('message') or ''
            text = f'{code}: {detail}' if code and detail else (code or detail)
            return text[:limit]
        text = json.dumps(body, separators=(',', ':'))
    else:
        text = str(body)
    text = re.sub(r'\s+', ' ', text)
    return text[:limit] + ('…' if len(text) > limit else '')


# ── HTTP with a browser's cookie behaviour, and no automatic redirects ───────────────────────

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


class Cookies:
    """Host-only, path-scoped cookies for ONE origin: what a browser keeps for the vertical."""

    def __init__(self):
        self.jar = {}  # name -> (value, path)

    def take(self, headers):
        for raw in headers.get_all('set-cookie') or []:
            parts = [p.strip() for p in raw.split(';')]
            if '=' not in parts[0]:
                continue
            name, value = parts[0].split('=', 1)
            attrs = {}
            for p in parts[1:]:
                k, _, v = p.partition('=')
                attrs[k.strip().lower()] = v.strip()
            path = attrs.get('path', '/')
            if attrs.get('max-age') == '0' or value == '':
                self.jar.pop(name, None)
            else:
                self.jar[name] = (value, path)

    def header(self, path):
        sent = [f'{n}={v}' for n, (v, p) in self.jar.items() if path.startswith(p)]
        return '; '.join(sent) if sent else None

    def names(self):
        return sorted(self.jar)


def request(url, method='GET', body=None, headers=None, cookies=None, timeout=60):
    """(status, headers, parsed-or-text body). Never raises on an HTTP status."""
    h = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h.setdefault('content-type', 'application/json')
    if cookies is not None:
        c = cookies.header(urllib.parse.urlsplit(url).path or '/')
        if c:
            h['cookie'] = c
    req = urllib.request.Request(url, method=method, headers=h, data=data)
    try:
        res = OPENER.open(req, timeout=timeout)
        status, rh, raw = res.status, res.headers, res.read()
    except urllib.error.HTTPError as e:
        status, rh, raw = e.code, e.headers, e.read()
    if cookies is not None:
        cookies.take(rh)
    text = raw.decode('utf-8', 'replace')
    ctype = rh.get('content-type', '')
    parsed = text
    if 'json' in ctype:
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            pass
    return status, rh, parsed


def wait_http(url, seconds, proc, what):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            status, _, _ = request(url, timeout=5)
            if status:
                return True
        except (urllib.error.URLError, ConnectionError, socket.timeout, OSError):
            pass
        time.sleep(0.5)
    return False


# ── processes: own process groups, and only those are stopped ───────────────────────────────

def start(name, argv, cwd, env, logdir):
    path = os.path.join(logdir, f'{name}.log')
    fh = open(path, 'w')
    proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    PROCS.append((name, proc, path))
    return proc, path


def group_members(pgid):
    out = subprocess.run(['pgrep', '-g', str(pgid)], capture_output=True, text=True).stdout.split()
    return [int(p) for p in out if p.strip().isdigit()]


def stop_all():
    for name, proc, _ in reversed(PROCS):
        pgid = proc.pid  # start_new_session: the leader's pid is the group id
        for sig, grace in ((signal.SIGTERM, 8), (signal.SIGKILL, 3)):
            if not group_members(pgid) and proc.poll() is not None:
                break
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                break
            deadline = time.time() + grace
            while time.time() < deadline and (group_members(pgid) or proc.poll() is None):
                time.sleep(0.2)
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
    PROCS.clear()


def tail(path, n=25):
    try:
        with open(path, errors='replace') as f:
            lines = f.read().splitlines()
        return '\n'.join('    | ' + l for l in lines[-n:])
    except OSError:
        return '    | (no log)'


# ── the project: copy, link, derive the deploy config ────────────────────────────────────────

def resolve_node_modules(project, given, app_given):
    """(node_modules, app/node_modules or None) to link the copy from."""
    if given:
        given = os.path.abspath(given)
        if os.path.basename(given) != 'node_modules' and os.path.isdir(os.path.join(given, 'node_modules')):
            nm = os.path.join(given, 'node_modules')
            app = os.path.join(given, 'app', 'node_modules')
        else:
            nm = given
            sib = os.path.join(os.path.dirname(given), 'app', 'node_modules')
            app = sib if os.path.isdir(sib) else os.path.join(project, 'app', 'node_modules')
    else:
        nm = os.path.join(project, 'node_modules')
        app = os.path.join(project, 'app', 'node_modules')
    if app_given:
        app = os.path.abspath(app_given)
    return nm, app


def install_complete(nm):
    return all(os.path.exists(os.path.join(nm, p)) for p in ('.modules.yaml', '.bin/wrangler', '@substrat-run/vertical-host/package.json'))


def wait_for_install(nm, seconds):
    if install_complete(nm):
        return
    log(f'[wait] {nm} is not a finished install yet; checking every 60 s for up to {seconds // 60} min')
    deadline = time.time() + seconds
    while time.time() < deadline:
        time.sleep(min(60, max(1, deadline - time.time())))
        if install_complete(nm):
            log('[wait] install finished')
            time.sleep(5)  # let the last writes land
            return
    die(f'{nm} never became a finished install (.modules.yaml + .bin/wrangler + @substrat-run/vertical-host)')


def shadow_link(src, dst):
    """A real directory holding one symlink per entry of `src`: resolution reaches the original
    packages, while anything a tool writes there (wrangler's .cache) lands in the copy."""
    os.makedirs(dst, exist_ok=True)
    for entry in os.listdir(src):
        if entry == '.cache':
            continue
        os.symlink(os.path.join(src, entry), os.path.join(dst, entry))


def copy_project(project, work):
    def ignore(d, names):
        skip = {'node_modules', '.wrangler', '.git', '.workerd-uploaded', '.dev.vars', 'wrangler.jsonc', 'wrangler.toml', 'wrangler.json'}
        return [n for n in names if n in skip]
    shutil.copytree(project, work, ignore=ignore, symlinks=True)


def dev_node(worker_src):
    try:
        text = open(worker_src).read()
    except OSError:
        return TEMPLATE_DEV_NODE, 'template default (worker unreadable)'
    block = re.search(r'DEV_NODE[^=]*=\s*\{(.*?)\}', text, re.S)
    scope = block.group(1) if block else text
    t = re.search(r"tenantId(?:\.parse)?\(\s*['\"]([0-9A-HJKMNP-TV-Z]{26})['\"]", scope)
    s = re.search(r"scopeId(?:\.parse)?\(\s*['\"]([0-9A-HJKMNP-TV-Z]{26})['\"]", scope)
    if t and s:
        return (t.group(1), s.group(1)), 'src/worker.ts DEV_NODE'
    return TEMPLATE_DEV_NODE, 'template default (no DEV_NODE found in the worker)'


INTROSPECT = r"""
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const dir = process.argv[2];
const out = { errors: [] };
let prov = {}, model = {};
try { prov = await import(pathToFileURL(resolve(dir, 'src/provision.ts')).href); } catch (e) { out.errors.push('src/provision.ts: ' + (e?.message ?? e)); }
try { model = await import(pathToFileURL(resolve(dir, 'spec/model.ts')).href); } catch (e) { out.errors.push('spec/model.ts: ' + (e?.message ?? e)); }
const mods = Array.isArray(prov.MODULES) ? prov.MODULES : [];
out.entitlementKeys = [...new Set([...(Array.isArray(prov.ENTITLEMENT_KEYS) ? prov.ENTITLEMENT_KEYS : []), ...mods.map((m) => m?.manifest?.entitlementKey).filter(Boolean)])];
out.modules = mods.map((m) => m?.manifest?.id ?? null);
out.ownerRoleKey = prov.OWNER_ROLE_KEY ?? null;
out.entityGrants = prov.ENTITY_GRANTS ?? null;
out.tables = Object.fromEntries(Object.entries(model.entities ?? {}).map(([k, v]) => [k, v?.table ?? null]));
out.operations = Object.entries(model.operations ?? {}).map(([name, v]) => ({
  name, http: v?.http ?? null, derive: v?.derive ?? null, paged: !!v?.paged,
  input: v?.input?.shape ? Object.keys(v.input.shape) : null,
}));
console.log('__INTROSPECT__' + JSON.stringify(out));
"""


def introspect(work, env):
    script = os.path.join(work, '.verify-hosted-introspect.mjs')
    with open(script, 'w') as f:
        f.write(INTROSPECT)
    tsx = os.path.join(work, 'node_modules', '.bin', 'tsx')
    if not os.path.exists(tsx):
        return None, 'no node_modules/.bin/tsx'
    r = subprocess.run([tsx, script, work], cwd=work, env=env, capture_output=True, text=True, timeout=180)
    line = [l for l in r.stdout.splitlines() if l.startswith('__INTROSPECT__')]
    if not line:
        return None, (r.stderr or r.stdout).strip()[-600:]
    return json.loads(line[-1][len('__INTROSPECT__'):]), None


def fallback_facts(work, pkg):
    """Read the same facts out of the source text when the import route failed."""
    facts = {'entitlementKeys': [], 'operations': [], 'tables': {}, 'entityGrants': None, 'errors': []}
    src = ''
    for root, _, files in os.walk(os.path.join(work, 'src')):
        for fn in files:
            if fn.endswith('.ts'):
                src += open(os.path.join(root, fn), errors='replace').read()
    facts['entitlementKeys'] = sorted(set(re.findall(r"entitlementKey:\s*['\"]([^'\"]+)['\"]", src)))
    try:
        spec = open(os.path.join(work, 'spec', 'model.ts'), errors='replace').read()
    except OSError:
        spec = ''
    for m in re.finditer(r"['\"]([a-z0-9-]+/[a-z0-9-]+)['\"]\s*:\s*\{", spec):
        chunk = spec[m.end():m.end() + 1500]
        nxt = re.search(r"\n  ['\"][a-z0-9-]+/[a-z0-9-]+['\"]\s*:\s*\{", chunk)
        chunk = chunk[:nxt.start()] if nxt else chunk
        http = re.search(r"http:\s*\{\s*method:\s*'([A-Z]+)',\s*path:\s*'([^']+)'", chunk)
        first = re.search(r"input:\s*z\.object\(\{\s*(\w+)\s*:", chunk)
        facts['operations'].append({'name': m.group(1), 'http': {'method': http.group(1), 'path': http.group(2)} if http else None,
                                    'paged': 'paged:' in chunk, 'derive': None, 'input': [first.group(1)] if first else None})
    for m in re.finditer(r"(\w+):\s*\{\s*(?:/\*\*.*?\*/\s*)?table:\s*'([^']+)'", spec, re.S):
        facts['tables'][m.group(1)] = m.group(2)
    if not facts['entitlementKeys'] and pkg.get('substrat', {}).get('slug'):
        facts['entitlementKeys'] = [pkg['substrat']['slug']]
    return facts


def pick_ops(ops, create_override, list_override):
    by = {o['name']: o for o in ops}
    def http(o):
        return o.get('http') or {}
    create = by.get(create_override) if create_override else None
    if not create:
        create = next((o for o in ops if o['name'].endswith('/create-list')), None) \
            or next((o for o in ops if http(o).get('method') == 'POST' and http(o).get('path') == '/lists'), None)
    lst = by.get(list_override) if list_override else None
    if not lst:
        lst = next((o for o in ops if http(o).get('method') == 'GET' and http(o).get('path') == '/lists'), None) \
            or next((o for o in ops if re.search(r'/(my-lists|list-lists|lists)$', o['name'])), None)
    join = next((o for o in ops if o['name'].endswith('/join')), None)
    return (create_override if create_override and not create else (create or {}).get('name')), \
           (list_override if list_override and not lst else (lst or {}).get('name')), (join or {}).get('name')


def door_facts(nm, work):
    facts = {}
    vh = os.path.join(nm, '@substrat-run', 'vertical-host')
    try:
        facts['vertical-host'] = json.load(open(os.path.join(vh, 'package.json')))['version']
    except (OSError, ValueError, KeyError):
        facts['vertical-host'] = '?'
    try:
        door = open(os.path.join(vh, 'dist', 'worker-door.js')).read()
        facts['door-joins-at-sign-in'] = 'yes' if ('deps.join' in door and 'grantSelfShapesLocal' in door) else 'no'
    except OSError:
        facts['door-joins-at-sign-in'] = '?'
    try:
        worker = open(os.path.join(work, 'src', 'worker.ts')).read()
        call = re.search(r'workerDoor<[^>]*>\(\{(.*?)\n\}\);', worker, re.S) or re.search(r'workerDoor\(\{(.*?)\n\}\);', worker, re.S)
        facts['worker-passes-join'] = 'yes' if call and re.search(r'^\s*join\s*[:(,]', call.group(1), re.M) else 'no'
    except OSError:
        facts['worker-passes-join'] = '?'
    return facts


def wrangler_config(pkg, work):
    needs = pkg.get('substrat', {}).get('runtimeNeeds')
    if not needs or not needs.get('entry'):
        die('package.json has no substrat.runtimeNeeds.entry: this harness runs the deployed worker, and there is none')
    stores = needs.get('stores') or []
    cfg = {
        'name': 'substrat-vertical',
        'main': needs['entry'],
        'compatibility_date': RUNTIME_BASELINE,
        'compatibility_flags': ['nodejs_compat'] if needs.get('needsNodeCompat') else [],
        'workers_dev': False,
        'vars': {'ALLOW_DEV_NODE': 'true'},
    }
    if stores:
        cfg['durable_objects'] = {'bindings': [{'name': s['binding'], 'class_name': s['class']} for s in stores]}
        cfg['migrations'] = [{'tag': 'v1', 'new_sqlite_classes': [s['class'] for s in stores]}]
    assets = needs.get('assets')
    note = None
    if assets and not isinstance(assets, dict):
        note = f'runtimeNeeds.assets is {type(assets).__name__}, not the object push reads: served without static assets'
        assets = None
    if assets and assets.get('directory'):
        if os.path.isdir(os.path.join(work, assets['directory'])):
            a = {'directory': assets['directory']}
            if assets.get('notFoundHandling'):
                a['not_found_handling'] = assets['notFoundHandling']
            if assets.get('runWorkerFirst') is not None:
                a['run_worker_first'] = assets['runWorkerFirst']
            cfg['assets'] = a
        else:
            note = f"assets dir {assets['directory']} not built; served without static assets (the API is unaffected)"
    return cfg, note


# ── the run ──────────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[1], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('project', help='the vertical project directory (holds package.json with substrat.runtimeNeeds)')
    ap.add_argument('--node-modules', help='node_modules to link from: a node_modules dir, or a project dir holding one (and app/node_modules)')
    ap.add_argument('--app-node-modules', help='app/node_modules to link from (default: beside --node-modules, else the project\'s)')
    ap.add_argument('--work-root', default=DEFAULT_WORK_ROOT, help='where the per-run copy is made (default: %(default)s)')
    ap.add_argument('--issuer-port', type=int, default=8899)
    ap.add_argument('--worker-port', type=int, default=8798)
    ap.add_argument('--inspector-port', type=int, default=9349)
    ap.add_argument('--persona', help='sub of the persona to pick at the issuer (default: the first listed)')
    ap.add_argument('--create-op', help='override the create-list operation name')
    ap.add_argument('--list-op', help='override the list-reading operation name')
    ap.add_argument('--expect', choices=['ok', 'refused'], default='ok',
                    help='outcome that exits 0: ok = create-list succeeds and the list op shows the new list; '
                         'refused = create-list is refused with a 4xx (default: ok)')
    ap.add_argument('--join-first', action='store_true',
                    help='DIAGNOSTIC: the harness invokes the build\'s join operation itself before create-list. '
                         'Not what the deployed door does; the verdict says harness-joined=yes when used')
    ap.add_argument('--wait-install', type=int, default=900, help='seconds to wait for an unfinished node_modules (default: %(default)s)')
    ap.add_argument('--boot-timeout', type=int, default=120)
    ap.add_argument('--clean', action='store_true', help='remove the work dir afterwards (default: kept, with the logs)')
    args = ap.parse_args()

    project = os.path.abspath(args.project)
    if not os.path.isfile(os.path.join(project, 'package.json')):
        die(f'{project} has no package.json')
    pkg = json.load(open(os.path.join(project, 'package.json')))
    slug = pkg.get('substrat', {}).get('slug') or pkg.get('name') or 'vertical'
    explicit = {a for a in ('--issuer-port', '--worker-port', '--inspector-port') if a in sys.argv or any(s.startswith(a + '=') for s in sys.argv)}

    nm, app_nm = resolve_node_modules(project, args.node_modules, args.app_node_modules)
    wait_for_install(nm, args.wait_install)

    stamp = time.strftime('%Y%m%d-%H%M%S')
    work = os.path.join(os.path.abspath(args.work_root), f'{os.path.basename(project.rstrip("/"))}-{stamp}-{secrets.token_hex(2)}')
    os.makedirs(os.path.dirname(work), exist_ok=True)
    copy_project(project, work)
    shadow_link(nm, os.path.join(work, 'node_modules'))
    if app_nm and os.path.isdir(app_nm) and os.path.isdir(os.path.join(work, 'app')):
        shadow_link(app_nm, os.path.join(work, 'app', 'node_modules'))
    logdir = os.path.join(work, '.verify-hosted')
    os.makedirs(logdir, exist_ok=True)

    env = node_env()
    # The declared build, as substrat push runs it before upload: what makes app/dist exist.
    needs = pkg.get('substrat', {}).get('runtimeNeeds') or {}
    ui_build = 'none'
    # substrat push parses runtimeNeeds.build as a command string and refuses anything else.
    if needs.get('build') is not None and not isinstance(needs.get('build'), str):
        print(f'HOSTED push-refused: runtimeNeeds.build is {type(needs["build"]).__name__}, push reads a command string')
        return 1
    if needs.get('build') and needs.get('assets'):
        # The copy's node_modules are links to a finished install: a pnpm that checks deps before a
        # run would reinstall into them (and pnpm 11 refuses a too-fresh lockfile entry while at it).
        benv = {**env, 'npm_config_verify_deps_before_run': 'false', 'pnpm_config_verify_deps_before_run': 'false'}
        b = subprocess.run(['sh', '-c', needs['build']], cwd=work, env=benv, capture_output=True, text=True, timeout=600)
        ui_build = 'ok' if b.returncode == 0 else 'failed'
        with open(os.path.join(logdir, 'ui-build.log'), 'w') as f:
            f.write(b.stdout + b.stderr)
        log(f'[ui] {needs["build"]} -> exit {b.returncode}')
    cfg, assets_note = wrangler_config(pkg, work)
    platform_secret = secrets.token_urlsafe(32)
    with open(os.path.join(work, 'wrangler.jsonc'), 'w') as f:
        json.dump(cfg, f, indent=2)
    # In .dev.vars, as wrangler dev reads a secret (vars are for plain settings).
    with open(os.path.join(work, '.dev.vars'), 'w') as f:
        f.write(f'PLATFORM_SECRET={platform_secret}\n')

    taken = set()
    issuer_port = pick_port(args.issuer_port, taken, '--issuer-port' in explicit); taken.add(issuer_port)
    worker_port = pick_port(args.worker_port, taken, '--worker-port' in explicit); taken.add(worker_port)
    inspector_port = pick_port(args.inspector_port, taken, '--inspector-port' in explicit); taken.add(inspector_port)
    issuer = f'http://localhost:{issuer_port}'
    base = f'http://localhost:{worker_port}'

    (tenant, scope), node_src = dev_node(os.path.join(work, cfg['main']))
    facts, why = introspect(work, env)
    facts_src = 'imported src/provision.ts + spec/model.ts'
    if facts is None or (not facts.get('operations') and not facts.get('entitlementKeys')):
        facts_src = f'read from source text (import failed: {brief(why, 160)})'
        facts = fallback_facts(work, pkg)
    if not facts.get('operations'):
        # The import found the entitlements but no operations: the model exports them under another name.
        facts['operations'] = fallback_facts(work, pkg)['operations']
        facts_src += '; operations read from spec/model.ts text'
    if not facts['entitlementKeys']:
        facts['entitlementKeys'] = [slug]
    create_op, list_op, join_op = pick_ops(facts.get('operations') or [], args.create_op, args.list_op)
    door = door_facts(nm, work)
    self_shape = next((g for g in (facts.get('entityGrants') or []) if g.get('holder') == 'self' and g.get('bootstrap')), None)
    self_table = (facts.get('tables') or {}).get(self_shape['entityType']) if self_shape else None
    owner = ulid()

    log(f'verify-hosted · {slug} · {project}')
    log(f'  work dir      {work}')
    log(f'  node_modules  {nm}  (vertical-host {door["vertical-host"]}; door joins at sign-in: {door["door-joins-at-sign-in"]}; worker passes join: {door["worker-passes-join"]})')
    log(f'  worker        {base}  (wrangler dev --local, main {cfg["main"]}, compat {cfg["compatibility_date"]} {cfg["compatibility_flags"] or "no flags"}, inspector :{inspector_port})')
    log(f'  issuer        {issuer}  (dev issuer, personas src/personas.ts)')
    log(f'  node          tenant {tenant} · scope {scope}  ({node_src})')
    log(f'  owner         {owner}  (fresh ULID, pending owner set at provision)')
    log(f'  entitlements  {", ".join(facts["entitlementKeys"])}  ({facts_src})')
    log(f'  operations    create={create_op} · list={list_op} · join={join_op or "none"}')
    if assets_note:
        log(f'  note          {assets_note}')
    log()

    result = {'signed-in': 'no', 'owner-bound': 'no', 'joined': 'unknown', 'self-shape': 'unknown', 'create-list': 'not-run', 'list': 'not-run', 'second-person': 'not-run'}
    detail = {}
    code = 2
    try:
        if not create_op:
            die('found no create-list operation in spec/model.ts (pass --create-op)')

        # 1. The issuer and the worker.
        issuer_bin = os.path.join(work, 'node_modules', '.bin', 'substrat-dev-issuer')
        personas = 'src/personas.ts'
        if not os.path.exists(issuer_bin):
            die('no node_modules/.bin/substrat-dev-issuer')
        if not os.path.exists(os.path.join(work, personas)):
            die('no src/personas.ts for the dev issuer')
        iproc, ilog = start('issuer', [issuer_bin, '--personas', personas, '--port', str(issuer_port)], work, env, logdir)
        wproc, wlog = start('wrangler', [os.path.join(work, 'node_modules', '.bin', 'wrangler'), 'dev', '--local', '--config', 'wrangler.jsonc',
                                         '--ip', '127.0.0.1', '--port', str(worker_port), '--inspector-port', str(inspector_port),
                                         '--persist-to', os.path.join(work, '.wrangler', 'state'), '--show-interactive-dev-session=false',
                                         '--log-level', 'log'], work, env, logdir)
        if not wait_http(f'{issuer}/.well-known/openid-configuration', 30, iproc, 'issuer'):
            die(f'the dev issuer did not come up on :{issuer_port}\n{tail(ilog)}')
        log(f'[boot] issuer up on :{issuer_port}')
        t0 = time.time()
        if not wait_http(f'{base}/api/__verify-hosted-ping', args.boot_timeout, wproc, 'worker'):
            die(f'wrangler dev did not serve the worker on :{worker_port} within {args.boot_timeout}s\n{tail(wlog, 40)}')
        log(f'[boot] worker up on :{worker_port} ({time.time() - t0:.0f}s)')

        plat = {PLATFORM_HEADER: platform_secret}

        # 2. Provision, as the control plane's /verticals/:slug/instances does.
        grants = [{'entitlementKey': k, 'expiresAt': None, 'quota': None, 'plan': None, 'grantedAt': now_iso(), 'grantedBy': None}
                  for k in facts['entitlementKeys']]
        body = {'tenantId': tenant, 'scopeId': scope, 'owner': owner, 'slug': f'{slug}-{scope[-6:].lower()}', 'name': pkg.get('substrat', {}).get('name') or slug,
                'entitlements': grants, 'identityLinks': [], 'connectionGrants': [], 'connectionKeys': []}
        s, _, b = request(f'{base}/internal/provision', 'POST', body, plat, timeout=120)
        log(f'[provision] POST /internal/provision -> {s} {brief(b)}')
        if s != 201:
            die(f'provision failed\n{tail(wlog)}')
        s, _, b = request(f'{base}/internal/owner-seat?tenantId={tenant}&scopeId={scope}', headers=plat)
        log(f'[provision] GET /internal/owner-seat -> {s} {brief(b)}')

        # 3. Configure the issuer, as the dashboard's identity step delivers it.
        auth = {'mode': 'oidc', 'issuer': issuer, 'clientId': f'{slug}-verify-hosted', 'clientSecret': secrets.token_urlsafe(24)}
        entries = [{'key': AUTH_CONFIG_KEY, 'value': json.dumps(auth)}, {'key': SHARED_ISSUER_KEY, 'value': ''}]
        s, _, b = request(f'{base}/internal/configure', 'POST', {'tenantId': tenant, 'scopeId': scope, 'entries': entries}, plat)
        log(f'[configure] POST /internal/configure ({AUTH_CONFIG_KEY} -> {issuer}) -> {s} {brief(b)}')
        if s != 200:
            die(f'configure failed\n{tail(wlog)}')

        # 4. Sign in as a browser would.
        jar = Cookies()
        s, h, b = request(f'{base}/api/auth/login?returnTo=/', cookies=jar)
        loc = h.get('location', '')
        log(f'[login] GET /api/auth/login -> {s} -> {loc.split("?")[0]}  cookies={jar.names()}')
        if s not in (302, 303) or not loc.startswith(issuer):
            die(f'login did not redirect to the issuer ({s} {brief(b)})\n{tail(wlog)}')
        s, h, page = request(loc)
        picks = [html.unescape(m) for m in re.findall(r'<a class="who[^"]*" href="([^"]+)"', page if isinstance(page, str) else '')]
        if s != 200 or not picks:
            die(f'the issuer picker did not list anyone ({s} {brief(page)})')
        pick = picks[0]
        if args.persona:
            pick = next((p for p in picks if urllib.parse.parse_qs(urllib.parse.urlsplit(p).query).get('sub') == [args.persona]), None)
            if not pick:
                die(f'persona {args.persona} is not on the picker')
        sub = urllib.parse.parse_qs(urllib.parse.urlsplit(pick).query).get('sub', ['?'])[0]
        log(f'[login] GET issuer /authorize -> {s} picker lists {len(picks)}; picking {sub}')
        s, h, b = request(urllib.parse.urljoin(issuer, pick))
        cb = h.get('location', '')
        if s not in (302, 303) or not cb.startswith(f'{base}/api/auth/callback'):
            die(f'the issuer did not send the browser back to the callback ({s} {cb or brief(b)})')
        log(f'[login] GET issuer /authorize&sub= -> {s} -> /api/auth/callback?code=…')
        s, h, b = request(cb, cookies=jar)
        back = h.get('location', '')
        log(f'[login] GET /api/auth/callback -> {s} -> {back}  cookies={jar.names()}')
        if s not in (302, 303) or 'error=' in back:
            detail['login'] = f'callback {s} -> {back}'
            log(tail(wlog))
        # The landing page, as the browser follows it: assets or the worker, either is fine.
        if back.startswith('/'):
            s2, _, _ = request(f'{base}{back}', cookies=jar)
            log(f'[login] GET {back} -> {s2}')

        # 5. Who is signed in.
        s, _, me = request(f'{base}/api/me', cookies=jar)
        log(f'[me] GET /api/me -> {s} {brief(me)}')
        if s == 200 and isinstance(me, dict) and me.get('principal'):
            result['signed-in'] = 'yes'
            result['owner-bound'] = 'yes' if me['principal'] == owner else f'no(other:{me["principal"]})'
        elif s == 200 and isinstance(me, dict) and me.get('status') == 'needs-setup':
            result['signed-in'] = 'needs-setup'
        else:
            result['signed-in'] = f'no({s})'
        s, _, b = request(f'{base}/internal/owner-seat?tenantId={tenant}&scopeId={scope}', headers=plat)
        log(f'[me] GET /internal/owner-seat -> {s} {brief(b)}')

        # 6. Create a list, then read lists.
        origin = {'origin': base}
        if args.join_first:
            if not join_op:
                die('--join-first: the build declares no */join operation')
            display = me.get('display') if isinstance(me, dict) and me.get('display') else 'Verify'
            s, _, b = request(f'{base}/api/invoke', 'POST', {'op': join_op, 'input': {'displayName': display}}, origin, cookies=jar, timeout=120)
            log(f'[join-first] POST /api/invoke {join_op} {{displayName}} -> {s} {brief(b)}  (harness-side, NOT the door)')
            detail['harness-joined'] = 'yes' if s in (200, 201) else f'failed({s})'
        name = f'verify-hosted {time.strftime("%H:%M:%S")}'
        keys = next((o.get('input') or [] for o in facts.get('operations') or [] if o['name'] == create_op), [])
        field = next((k for k in ('name', 'title') if k in keys), keys[0] if keys else 'name')
        s, _, b = request(f'{base}/api/invoke', 'POST', {'op': create_op, 'input': {field: name}}, origin, cookies=jar, timeout=120)
        log(f'[create] POST /api/invoke {create_op} {{{field}}} -> {s} {brief(b)}')
        created_id = b.get('id') if isinstance(b, dict) and s in (200, 201) else None
        if created_id:
            result['create-list'] = 'ok'
        else:
            result['create-list'] = 'refused' if 400 <= s < 500 else 'failed'
            detail['create-list'] = f'{s} {brief(b, 120)}'
        if list_op:
            s, _, b = request(f'{base}/api/invoke', 'POST', {'op': list_op, 'input': {}}, origin, cookies=jar, timeout=60)
            rows = b if isinstance(b, list) else next((b[k] for k in ('entries', 'items', 'rows', 'data') if isinstance(b, dict) and isinstance(b.get(k), list)), None)
            log(f'[list] POST /api/invoke {list_op} {{}} -> {s} {brief(b)}')
            if s == 200 and rows is not None:
                has = bool(created_id) and any(isinstance(r, dict) and r.get('id') == created_id for r in rows)
                result['list'] = f'{len(rows)}-rows' + (('(has-new)' if has else '(new-list-missing)') if created_id else '')
                detail['list-has-new'] = has
            else:
                result['list'] = f'{s}'
                detail['list'] = brief(b, 120)

        # 6c. A second, invited person: the owner shares the new list by email, that person signs in
        # through the same door with their own cookies, and must see the list. Every share and invite
        # path ends here on a deployed app, and the owner alone never exercises it.
        def sign_in(want):
            j = Cookies()
            s, h, _ = request(f'{base}/api/auth/login?returnTo=/', cookies=j)
            loc = h.get('location', '')
            if s not in (302, 303) or not loc.startswith(issuer):
                return j, None, f'login-{s}'
            s, h, pg = request(loc)
            links = [html.unescape(m) for m in re.findall(r'<a class="who[^"]*" href="([^"]+)"', pg if isinstance(pg, str) else '')]
            link = next((l for l in links if urllib.parse.parse_qs(urllib.parse.urlsplit(l).query).get('sub') == [want]), None)
            if not link:
                return j, None, 'not-on-picker'
            s, h, _ = request(urllib.parse.urljoin(issuer, link))
            cb2 = h.get('location', '')
            if s not in (302, 303) or not cb2.startswith(f'{base}/api/auth/callback'):
                return j, None, f'authorize-{s}'
            s, h, _ = request(cb2, cookies=j)
            if s not in (302, 303) or 'error=' in h.get('location', ''):
                return j, None, f'callback-{s}'
            s, _, who = request(f'{base}/api/me', cookies=j)
            return j, (who if s == 200 and isinstance(who, dict) and who.get('principal') else None), f'me-{s}'

        ops = facts.get('operations') or []
        invite_op = next((o['name'] for o in ops if o['name'].endswith('/invite')), None) \
            or next((o['name'] for o in ops if o['name'].endswith('/share-list')), None)
        cast = re.findall(r"sub: '([^']+)'[^\n}]*?email: '([^']+)'", open(os.path.join(work, personas)).read())
        second = next(((s2, e2) for s2, e2 in cast if s2 != sub), None)
        if not (created_id and invite_op and second and list_op):
            result['second-person'] = 'not-run'
            detail['second-person'] = f'list={bool(created_id)} invite-op={invite_op} second={bool(second)} list-op={list_op}'
        else:
            keys2 = next((o.get('input') or [] for o in ops if o['name'] == invite_op), [])
            lkey = next((k for k in keys2 if k in ('listId', 'list_id')), next((k for k in keys2 if k.lower().endswith('id')), 'listId'))
            ekey = next((k for k in keys2 if 'email' in k.lower()), 'email')
            s, _, b = request(f'{base}/api/invoke', 'POST', {'op': invite_op, 'input': {lkey: created_id, ekey: second[1]}}, origin, cookies=jar, timeout=120)
            log(f'[second] POST /api/invoke {invite_op} {{{lkey}, {ekey}: {second[1]}}} -> {s} {brief(b)}')
            if s not in (200, 201):
                result['second-person'] = f'invite-{s}'
                detail['second-person'] = brief(b, 120)
            else:
                jar2, me2, how = sign_in(second[0])
                log(f'[second] {second[0]} signs in -> {how} {brief(me2) if me2 else ""}')
                if not me2:
                    result['second-person'] = f'signin-failed({how})'
                else:
                    seen, s = False, None
                    for _ in range(16):
                        s, _, b = request(f'{base}/api/invoke', 'POST', {'op': list_op, 'input': {}}, origin, cookies=jar2, timeout=60)
                        rows2 = b if isinstance(b, list) else next((b[k] for k in ('entries', 'items', 'rows', 'data') if isinstance(b, dict) and isinstance(b.get(k), list)), [])
                        if s == 200 and any(isinstance(r, dict) and r.get('id') == created_id for r in rows2):
                            seen = True
                            break
                        time.sleep(0.5)
                    log(f'[second] POST /api/invoke {list_op} as {second[0]} -> {s} {"has the shared list" if seen else brief(b)}')
                    result['second-person'] = 'sees-shared' if seen else f'not-shared({s})'
                    if not seen:
                        detail['second-person'] = brief(b, 120)

        # 6b. The app, as a person opening the deployed vertical meets it: the page at /, and at a
        # deep link the app routes itself, while /api/* stays the worker's.
        if needs.get('assets'):
            s1, h1, b1 = request(f'{base}/', 'GET', None, {}, cookies=jar, timeout=30)
            s2, h2, b2 = request(f'{base}/lists/some-deep-link', 'GET', None, {}, cookies=jar, timeout=30)
            page = lambda s, b: s == 200 and isinstance(b, str) and '<script' in b.lower()
            result['ui'] = ('served' if page(s1, b1) and page(s2, b2) else 'root-only' if page(s1, b1) else f'not-served-{s1}') + f'(build-{ui_build})'
            log(f'[ui] GET / -> {s1} {brief(b1, 80)}; GET /lists/some-deep-link -> {s2} {brief(b2, 80)}')
        else:
            result['ui'] = 'no-assets-declared'

        # 7. What the scope holds for the owner, read through the platform's read-only console.
        if self_table and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', self_table):
            s, _, b = request(f'{base}/internal/query', 'POST', {'scopeId': scope, 'sql': f"SELECT COUNT(*) AS n FROM {self_table} WHERE id = '{owner}'"}, plat)
            n = _first_n(b)
            log(f'[state] {self_table} row for the owner -> {s} {brief(b, 120)}')
            result['joined'] = 'yes' if n else ('no' if n == 0 else 'unknown')
            etype = self_shape['entityType']
            # Every tuple the owner holds, so an empty answer for their own record is seen beside
            # the ones that are there (the role seat), not mistaken for a query that matched nothing.
            s, _, b = request(f'{base}/internal/query', 'POST', {'scopeId': scope, 'sql': f"SELECT relation, object FROM _substrat_tuples WHERE subject = 'principal:{owner}' ORDER BY object, relation"}, plat)
            held = _rows(b)
            if held is not None:
                shown = ', '.join(f'{r}@{o.replace(owner, "<owner>").replace(scope, "<scope>")}' for r, o in held) or '(none)'
                log(f'[state] tuples the owner holds -> {s} {shown}')
                on_own = {r for r, o in held if o == f'{etype}:{owner}'}
                want = {f'granted:{k}' for k in self_shape.get('permissions', [])}
                result['self-shape'] = 'yes' if want and want <= on_own else ('partial' if want & on_own else 'no')
            else:
                log(f'[state] tuples the owner holds -> {s} {brief(b, 160)}')
        elif result['create-list'] == 'ok':
            result['joined'] = 'yes'

        for marker in ('door-join-failed', 'oidc.callback.failed', 'Uncaught', 'UncheckedOperation'):
            hits = [l.strip() for l in open(wlog, errors='replace') if marker in l]
            if hits:
                log(f'[worker-log] {marker}: {brief(hits[-1], 240)}')
        # `ok` is the whole claim: the list is created AND its creator can see it.
        works = result['create-list'] == 'ok' and (not list_op or detail.get('list-has-new', False))
        code = 0 if (works if args.expect == 'ok' else result['create-list'] == 'refused') else 1
    finally:
        stop_all()
        busy = [p for p in (issuer_port, worker_port, inspector_port) if _listening(p)]
        log()
        log(f'[cleanup] stopped {", ".join(n for n in ("issuer", "wrangler"))}; ports {issuer_port}/{worker_port}/{inspector_port} '
            + ('free' if not busy else f'STILL LISTENING: {busy}'))
        if args.clean:
            shutil.rmtree(work, ignore_errors=True)
        else:
            log(f'[cleanup] logs kept in {logdir}')

    extra = ''
    if detail.get('create-list'):
        extra = f' ({detail["create-list"]})'
    log()
    log(f'HOSTED signed-in={result["signed-in"]} owner-bound={result["owner-bound"]} joined={result["joined"]} '
        f'self-shape={result["self-shape"]} create-list={result["create-list"]}{extra} list={result["list"]} ui={result.get("ui", "not-run")} second={result["second-person"]}'
        + (f' harness-joined={detail["harness-joined"]}' if detail.get('harness-joined') else '')
        + (f' login=({detail["login"]})' if detail.get('login') else ''))
    return code


def _first_n(b):
    rows = b.get('rows') if isinstance(b, dict) else b
    if isinstance(rows, list) and rows:
        r = rows[0]
        if isinstance(r, dict):
            return next(iter(r.values()), None)
        if isinstance(r, list) and r:
            return r[0]
    return None


def _rows(b):
    """(relation, object) pairs out of the console's {columns, rows} answer, or None."""
    rows = b.get('rows') if isinstance(b, dict) else b
    if not isinstance(rows, list):
        return None
    out = []
    for r in rows:
        if isinstance(r, dict):
            out.append((str(r.get('relation')), str(r.get('object'))))
        elif isinstance(r, list) and len(r) >= 2:
            out.append((str(r[0]), str(r[1])))
    return out


def _listening(port):
    r = subprocess.run(['lsof', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN'], capture_output=True, text=True)
    return bool(r.stdout.strip())


if __name__ == '__main__':
    def _term(signum, frame):
        stop_all()
        raise SystemExit(130)
    signal.signal(signal.SIGINT, _term)
    signal.signal(signal.SIGTERM, _term)
    try:
        sys.exit(main())
    except SystemExit:
        stop_all()
        raise
