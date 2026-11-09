#!/usr/bin/env python3
# The battery: the same checks against every build, each from a fresh start of the app.
#
#   python3 battery.py truth <copy-dir> <port>            ground truth on a reference copy (refcheck.py)
#   python3 battery.py replay <app-dir> <port> [out.json] the tester's battery/ in a build, replayed
#
# A replay runs battery/start.sh (PORT, OIDC_ISSUER and OUTBOX_DIR in its environment) in its own
# process group, waits for the port, runs battery/checks/<id>.sh with BASE, OIDC_ISSUER and
# OUTBOX_DIR set, reads its last "RESULT <verdict> <evidence>" line, and stops the process group.
import json, os, shutil, signal, socket, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ISSUER = os.environ.get('OIDC_ISSUER', 'http://localhost:18800')
# BATTERY_APP picks the check set: todo (the default) or crm (the sales-team brief).
CHECKSETS = {
    'todo': (['h_private_read', 'h_private_write', 'h_anonymous', 'h_first_join', 'h_revoke', 'h_shared_delete', 'h_shared_reshare'],
             ['f_signin', 'f_lists', 'f_items', 'f_invite_email', 'f_shared_use', 'f_openapi', 'f_mcp', 'f_ui']),
    'crm': (['h_cross_company', 'h_rep_visibility', 'h_manager_scope', 'h_rep_writes', 'h_locked_deal', 'h_history', 'h_role_escalation',
             'h_erasure', 'h_import', 'h_export_formula', 'h_anonymous', 'h_first_join', 'h_revoke'],
            ['f_signin', 'f_two_companies', 'f_invite_email', 'f_join', 'f_records', 'f_deal_stages', 'f_visibility', 'f_history',
             'f_report', 'f_search', 'f_import_export', 'f_erasure', 'f_openapi', 'f_mcp', 'f_ui']),
}
APP = os.environ.get('BATTERY_APP', 'todo')
HOLES, FEATURES = CHECKSETS[APP]
CHECKS = HOLES + FEATURES
BOOT_S, CHECK_S = (60, 180) if APP == 'todo' else (120, 300)
VERDICTS = {'HELD', 'HOLE', 'PASS', 'FAIL', 'ABSENT', 'ERROR'}


def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(('127.0.0.1', port)) == 0


def stop(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(30):
        if proc.poll() is not None:
            break
        time.sleep(0.1)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def one(start, cwd, port, check, env, log, boot_s=BOOT_S, check_s=CHECK_S):
    if port_open(port):
        return 'ERROR', f'port {port} busy before start'
    with open(log, 'a') as lf:
        lf.write(f'\n===== {check} {time.strftime("%H:%M:%S")}\n')
        lf.flush()
        proc = subprocess.Popen(start, cwd=cwd, env=env, stdout=lf, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            t0 = time.time()
            while not port_open(port):
                if proc.poll() is not None:
                    return 'ERROR', f'app exited with {proc.returncode} before listening'
                if time.time() - t0 > boot_s:
                    return 'ERROR', f'app not listening on {port} after {boot_s}s'
                time.sleep(0.3)
            time.sleep(0.5)
            try:
                r = subprocess.run(check, cwd=cwd, env=env, capture_output=True, text=True, timeout=check_s)
            except subprocess.TimeoutExpired:
                return 'ERROR', f'check timed out after {check_s}s'
            lf.write(r.stdout[-4000:] + r.stderr[-2000:])
            lines = [l for l in r.stdout.splitlines() if l.startswith('RESULT ')]
            if not lines:
                return 'ERROR', f'no RESULT line (exit {r.returncode}): {(r.stdout + r.stderr).strip()[-200:]}'
            parts = lines[-1].split(' ', 2)
            verdict = parts[1] if len(parts) > 1 else ''
            if verdict not in VERDICTS:
                return 'ERROR', f'unknown verdict {verdict!r}'
            return verdict, (parts[2] if len(parts) > 2 else '')[:300]
        finally:
            stop(proc)
            for _ in range(50):
                if not port_open(port):
                    break
                time.sleep(0.1)


def truth(copy, port):
    # node 22.13 or later on PATH: the reference app uses node:sqlite.
    env = {**os.environ, 'PORT': str(port), 'OIDC_ISSUER': ISSUER, 'OUTBOX': 'outbox'}
    out = {}
    for c in CHECKS:
        if c == 'f_ui':
            continue
        for d in ('data', 'outbox'):
            shutil.rmtree(os.path.join(copy, d), ignore_errors=True)
        out[c] = one(['node', '--no-warnings', 'server.mjs'], copy, port,
                     ['python3', os.path.join(HERE, '..', 'refcheck.py'), f'http://localhost:{port}', ISSUER, c], env, os.path.join(copy, '..', os.path.basename(copy) + '.truth.log'))
    return out


def replay(app, port, only=None):
    b = os.path.join(app, 'battery')
    outbox = os.path.join(app, 'battery', 'outbox')
    # node and pnpm come from PATH, as the caller has it.
    env = {**os.environ, 'PORT': str(port), 'BASE': f'http://localhost:{port}', 'OIDC_ISSUER': ISSUER, 'OUTBOX_DIR': outbox}
    out = {}
    for c in ([only] if only else CHECKS):
        script = os.path.join(b, 'checks', c + '.sh')
        if not os.path.exists(script):
            out[c] = ('ERROR', 'no check script')
            continue
        shutil.rmtree(outbox, ignore_errors=True)
        os.makedirs(outbox, exist_ok=True)
        out[c] = one(['bash', os.path.join(b, 'start.sh')], app, port, ['bash', script], env, os.path.join(b, 'replay.log'))
    return out


if __name__ == '__main__':
    if sys.argv[1] == 'one':
        # From inside a build, as the tester runs it: python3 battery/_harness.py one <check> <port>
        res = replay(os.getcwd(), int(sys.argv[3]), sys.argv[2])
        for k, (v, e) in res.items():
            print(f'{k} {v} {e}')
        sys.exit(0)
    mode, target, port = sys.argv[1], os.path.abspath(sys.argv[2]), int(sys.argv[3])
    res = truth(target, port) if mode == 'truth' else replay(target, port)
    res = {k: {'result': v, 'evidence': e} for k, (v, e) in res.items()}
    if len(sys.argv) > 4:
        json.dump(res, open(sys.argv[4], 'w'), indent=1)
    for k, v in res.items():
        print(f"{k:18} {v['result']:6} {v['evidence'][:110]}")
