/**
 * The runtime half of `ctx.check`'s `PermissionKey` parameter (#1642).
 *
 * The brand is compile-time only, so a module that casts (`'Workorder:Read' as
 * PermissionKey`) hands the host a string no manifest and no role could ever carry.
 * Until this, both adapters took it on trust: the checker refused it (nothing holds
 * it), the refusal was recorded in the denial log under a key that is not a
 * permission, and the author read `permission denied` for what is a typo. On the
 * system-actor path, which allows without consulting a grant, it went further: the
 * key became the relation of the proof the check returned, and `ctx.grant` wrote it
 * into `_substrat_tuples`.
 *
 * So both adapters call this FIRST in `runCheck` — above the system-actor early
 * return, which is the path that never reaches the checker — and `ctx.grant` /
 * `ctx.revoke` inherit it because they re-check through `runCheck` before writing.
 *
 * **Why a throw and not a denial.** Both refuse, so neither lets the call through:
 * a throw returns no `Decision`, so there is nothing for `assertAllowed` to pass and
 * nothing is added to the K-34 `authorization` the operation's events carry. A
 * caller that catches it and carries on has skipped a check, exactly as one that
 * never called `ctx.check` has — no more than that. What differs is who is told. A
 * denial is a statement about a principal ("was refused X"), and X here is not a
 * permission; recording it fills the denial log with rows that read as an
 * authorization problem, and on the system-actor path a denial is not even an
 * available answer. It is a bug in the module, so it is `internal` — a 500 whose
 * `detail` never leaves the server — and the message names the key for the log.
 */
import { permissionKey, substratError, type PermissionKey } from '@substrat-run/contracts';

export function assertPermissionKey(permission: unknown): PermissionKey {
  const parsed = permissionKey.safeParse(permission);
  if (parsed.success) return parsed.data;
  throw substratError(
    'internal',
    `ctx.check was handed ${JSON.stringify(permission)}, which is not a permission key ` +
      `(${parsed.error.issues.map((i) => i.message).join('; ')}) — a bug in the calling ` +
      'module, not a refusal: nothing was checked and no denial was recorded',
  );
}
