---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contracts': minor
'@substrat-run/contract-tests': minor
---

The membership executor can join the org an invitation names (#2047). Mount it with `registerMembershipExecutor(host, { actor, orgs: 'join' })`. An add then joins the org and a removal takes the person out of it, in the same directory unit as the role. Both are bounded by the inviter's or remover's own live membership of that org. A member holds everything the org confers, including its grants in each scope's own store, so that is the whole bound. A tenant admin who is not a member of the org cannot invite into it. The joiner's membership expires no later than the inviter's own. The default (`orgs: 'ignore'`) is unchanged: role only.

`HostAdmin.applyMembership` takes an optional `orgId` and can refuse with `unknownOrg` or `notMember`. `HostAdmin.addMember` takes an optional `{ expiresAt }`, and `listMembers` reports each membership's `expiresAt`. The kernel exports `liveOrgMembership` and `joinedMembershipExpiry`.
