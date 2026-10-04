---
'@substrat-run/kernel': patch
'@substrat-run/contracts': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': patch
---

The peer kill switch (`revokeFromPeer`) is now kept like the schedule kill switch: recorded outside the scope, put back by every carry, held through a point-in-time rewind, and able to switch off a peer whose only authority is tenant-wide.

**The switch is recorded in the directory.** `revokeFromPeer` and `restoreToPeer` write the directory's record of the peer's position before the scope moves, as `revokeFromSystem` does, in a new `_substrat_peer_switches` table. The record is backfilled once from the admin log, so peers switched off before this release are recorded too. A failed move takes the record back only when the scope reads back in the other position. A move that returns nothing to switch also takes it back.

**Every carry puts it back.** `HostAdmin.reassertSystemSwitches` now re-asserts the recorded-off peers after the modules. It is audited as `reassertPeerSwitch`, and each entry in its answer names `vertical` instead of `moduleId`. A hosted provision, reconcile or restore also carries the peers (`switchedOffPeers`, `tenantHeldPeers`), so the deployment switches them back off in the same unit that seats their grants again. A deployment built before this ignores those fields, and the re-assert after the call switches the peers off instead. `HostAdmin.peerSwitchCarry` is the platform's read for this.

**A rewind holds a switched-off peer.** A point-in-time rewind to before a peer was switched off used to bring the peer's grants back with no switch, so it was admitted again. The rewind now holds the scope's off peers beside its off modules. Every peer entry checks the hold after the scope's own state and is pinned to the scope instance it read: an invoke through `getVerticalScope`, a delivery, `peerCovers`, and a producer's export read for that consumer. While a peer is held, an invoke is refused with `forbidden`, a delivery pauses its edge, and the coverage and export reads answer that the peer holds nothing. The hold ends when the switch moves again on the rewound scope: an operator's ON, or the next reconcile's re-assert. A door now also checks the hold for a subject the scope reports as `ungranted`, because a subject with only tenant-wide authority comes back from a rewind with no row on the scope. The scope refuses a peer call that carries no pin, as it already did for a module call.

**A peer with only tenant-wide authority can be switched off.** `revokeFromPeer` used to answer `not_found` when the scope held no grant for the peer. Now the switch asks the directory whether the tenant holds a live tenant-wide `vertical:` grant. If it does, OFF writes the scope's switch, and `restoreToPeer` takes it back. For a hosted scope, the platform sends `tenantHeld` with `/internal/peer-switch`, and `peerSwitchLocal` takes it as `opts.tenantHeld`. A deployment built before this ignores the field and answers `not_found`, as before.

**Kernel API.** The record functions take the switch's kind (`'system'` or `'peer'`), and the module-only names are gone: `recordSwitchedOff` and `recordSwitchedOn` (were `recordSystemSwitchedOff` and `recordSystemSwitchedOn`), `restoreSwitchRecord`, `switchRecordsOf`, `switchedOffOf`, `tenantHoldsGrant`, `switchesTableExists`, `dumpCarriesSwitches` and `forgetSwitchesOf`. `moveSwitch` moves either kind, and `switchRecordedOff` takes `verticals` and `tenantHeldVerticals`. `switchedOffInUnit` also accepts a peer's entry.
