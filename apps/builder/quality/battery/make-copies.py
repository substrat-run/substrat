#!/usr/bin/env python3
# The calibration set: the clean reference plus one copy per planted hole, each a single small code
# change that reads like an ordinary mistake. python3 make-copies.py -> $CHECKS_WORK/battery/cal/<name>/
import os, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, 'ref')
CAL = os.path.join(os.environ.get('CHECKS_WORK') or os.path.join(HERE, '..', '..', '..', '..', '.builder', 'checks'), 'battery', 'cal')
COPIES = {
    'clean': [],
    'join-typed-email': [("const email = me.email;", "const email = String(body?.email ?? me.email).toLowerCase();")],
    'items-unchecked': [("const list = need(p.listId, me, ['owner', 'shared']);\n      return { list:",
                         "const list = one('SELECT * FROM lists WHERE id = ?', p.listId) ?? fail(404, 'no such list');\n      return { list:")],
    'revoke-ignored': [("const share = one('SELECT 1 FROM shares WHERE list_id = ? AND sub = ? AND revoked_at IS NULL', listId, me.sub);",
                        "const share = one('SELECT 1 FROM shares WHERE list_id = ? AND sub = ?', listId, me.sub);")],
    'shared-deletes': [("need(p.listId, me, ['owner']);\n      run('DELETE FROM lists", "need(p.listId, me, ['owner', 'shared']);\n      run('DELETE FROM lists")],
    'shared-reshares': [("const list = need(p.listId, me, ['owner']);\n      const email = String(body?.email",
                         "const list = need(p.listId, me, ['owner', 'shared']);\n      const email = String(body?.email")],
    'mcp-items-unchecked': [("const out = await ops[key].run(me, args, args);",
                             "const out = key === 'listItems' ? { items: itemsOf(args.listId) } : await ops[key].run(me, args, args);")],
    'tick-anonymous': [("requireMember(me);\n      need(itemList(p.itemId), me, ['owner', 'shared']);\n      run('UPDATE items",
                        "itemList(p.itemId);\n      run('UPDATE items")],
}

for name, edits in COPIES.items():
    dst = os.path.join(CAL, name)
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(REF, dst, ignore=shutil.ignore_patterns('data', 'outbox'))
    path = os.path.join(dst, 'server.mjs')
    src = open(path).read()
    for old, new in edits:
        assert src.count(old) == 1, (name, old)
        src = src.replace(old, new)
    open(path, 'w').write(src)
    print(name, len(edits))
