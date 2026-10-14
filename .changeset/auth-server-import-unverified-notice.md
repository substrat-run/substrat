---
'@substrat-run/demo-auth-server': patch
---

The user import's preview and report warn about new people imported without `email_verified` (part of #1359). A relying party that identifies someone by address refuses an unverified one, so an export that dropped the column would lock every imported person out of a staff roster or an invite after cutover. The dry run now counts new people whose file entry carries no flag apart from those it reads as not verified, and says how to fix the export. Each created outcome carries the entry's own flag (`null` when it had none), and the result carries `unverified: { unasserted, unverified }`. What is stored is unchanged: an entry with no flag is still imported as unverified, and a person merged onto an existing row keeps the flag already stored.
