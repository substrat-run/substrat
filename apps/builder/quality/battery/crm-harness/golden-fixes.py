#!/usr/bin/env python3
# golden-fixes.py <app> — the two hand fixes that make lane 2's build the CRM golden v1:
# CSV cells a spreadsheet would run as formulas are opened as text, and the deal and contact forms
# pick a company by name instead of asking for an id no screen shows.
import sys
G = sys.argv[1]
p = G + '/src/module.ts'; t = open(p).read()
old = """const csvCell = (v: string): string => (/[",\\n\\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);"""
new = """/**
 * One CSV field. A value a spreadsheet would run as a formula (one starting with =, +, -, @, a tab or
 * a carriage return) is prefixed with a quote, so it opens as text.
 */
const csvCell = (raw: string): string => {
  const v = /^[=+\\-@\\t\\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\\n\\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};"""
assert t.count(old) == 1, 'csvCell'
open(p, 'w').write(t.replace(old, new))
p = G + '/app/src/screens.ts'; t = open(p).read()
old = """const COMPANY_COLUMNS: Column<Company>[] = [{ key: 'name', label: 'Company', sort: 'name' }];"""
new = old + """

/** The company a new deal or contact belongs to, picked by name: no screen shows a company's id. */
const companyPicker = (): unknown =>
  loaded(
    () => COMPANIES.read({ view: null, sort: 'name', order: 'asc', filters: {}, q: '', limit: 200 }),
    (page) => html`<wa-select name="companyId" label="Company" required>
      ${page.entries.map((c) => html`<wa-option value=${c.id}>${c.name}</wa-option>`)}
    </wa-select>`,
  );"""
assert t.count(old) == 1, 'columns'
t = t.replace(old, new)
inp = '<wa-input name="companyId" label="Company id" required></wa-input>'
assert t.count(inp) == 2, 'inputs'
open(p, 'w').write(t.replace(inp, '${companyPicker()}'))
print('edited')
