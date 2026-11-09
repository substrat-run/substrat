#!/usr/bin/env python3
# The CRM calibration set: the golden (lane 2's builder build with two hand fixes) and one copy per
# planted hole, each a small edit that reads like an ordinary mistake. Dependencies are cloned
# copy-on-write from the golden. python3 make-copies-crm.py -> $CHECKS_WORK/battery/tests/crm-cal-NN/app,
# map in crm-cal-map.txt. The golden is $CHECKS_WORK/battery/golden-crm/app.
#
# No copy plants a cross-company hole: in a builder build the kernel checks the caller's grants in
# the space it addresses, so no one-line mistake in the vertical lets Birch read Acme. That check is
# calibrated on a plain build instead.
import os, shutil, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
W = os.path.join(os.environ.get('CHECKS_WORK') or os.path.join(HERE, '..', '..', '..', '..', '..', '.builder', 'checks'), 'battery')
GOLDEN = os.path.join(W, 'golden-crm', 'app')
M = 'src/module.ts'
COPIES = {
    'clean': [],
    'listing-unchecked': [(M, "      async (deal) => (await ctx.check(CRM_PERM.dealView, dealRef(deal.id))).allowed,\n      { continuation: ctx.pageContinuation('deal:my-deals', input) },",
                           "      async () => true,\n      { continuation: ctx.pageContinuation('deal:my-deals', input) },")],
    'locked-value': [(M, "    const deal = dealOrThrow(ctx, input.dealId);\n    assertOpen(deal);\n    ctx.sql.exec('UPDATE crm_deals SET value = ?",
                      "    const deal = dealOrThrow(ctx, input.dealId);\n    ctx.sql.exec('UPDATE crm_deals SET value = ?")],
    'value-no-history': [(M, "    addHistory(ctx, deal.id, 'value', `${deal.value} ${deal.currency}`, `${input.value} ${input.currency}`);\n", "")],
    'anyone-invites': [(M, "  'crm/invite-member': async (ctx, input) => {\n    assertAllowed(await ctx.check(CRM_PERM.memberManage));",
                        "  'crm/invite-member': async (ctx, input) => {\n    assertAllowed(await ctx.check(CRM_PERM.read));")],
    'erase-keeps-row': [(M, "every note written about them go; history and events only ever held ids.\n    ctx.sql.exec(`DELETE FROM crm_record_notes WHERE subject_type = 'contact' AND subject_id = ?`, [input.contactId]);\n    ctx.sql.exec('DELETE FROM crm_contacts WHERE id = ?', [input.contactId]);",
                         "every note written about them go; history and events only ever held ids.\n    ctx.sql.exec(`DELETE FROM crm_record_notes WHERE subject_type = 'contact' AND subject_id = ?`, [input.contactId]);\n    ctx.sql.exec(\"UPDATE crm_contacts SET name = 'Erased contact' WHERE id = ?\", [input.contactId]);")],
    'export-formula': [(M, "  const v = /^[=+\\-@\\t\\r]/.test(raw) ? `'${raw}` : raw;\n", "  const v = raw;\n")],
    'revoke-keeps-grant': [(M, "    for (const perm of SHARE_GRANTS) {\n      await ctx.revoke(principalId.parse(share.member_id), perm, dealRef(share.deal_id));\n    }\n", "")],
}

lines = []
for i, (name, edits) in enumerate(COPIES.items(), start=1):
    n = f'crm-cal-{i:02d}'
    dst = os.path.join(W, 'tests', n, 'app')
    shutil.rmtree(os.path.join(W, 'tests', n), ignore_errors=True)
    os.makedirs(os.path.dirname(dst))
    subprocess.run(['cp', '-Rc', GOLDEN, dst], check=True)
    for d in ('battery', '.data'):
        shutil.rmtree(os.path.join(dst, d), ignore_errors=True)
    for f, old, new in edits:
        p = os.path.join(dst, f)
        src = open(p).read()
        assert src.count(old) == 1, (name, old[:60])
        open(p, 'w').write(src.replace(old, new))
    lines.append(f'{n} {name}')
    print(n, name, len(edits))
open(os.path.join(HERE, 'crm-cal-map.txt'), 'w').write('\n'.join(lines) + '\n')
