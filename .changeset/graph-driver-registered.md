---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
'@substrat-run/control-plane-api': minor
---

The `graph` store driver is registered in `STORE_DRIVERS`, on D-67, which is admitted in `STORE_DRIVER_ADMITTED_ISOLATION_LIFTS`. A push that declares `driver: 'graph'` now passes `substrat push`'s check and the control plane's. No release of the driver is approved yet, so a hosted push, serve or raw version publish (`POST /verticals/:slug/versions`) that declares it is refused before anything is uploaded or published; the raw publish now puts a version's store scripts in place first, as a push does. With a driver registered, backup, wipe and erasure refuse (503) a scope whose running version cannot be told where a version of its vertical declared a store. Once a graph store holds data, never roll the control plane back below this release: an older one skips stores in backup, wipe and erasure.
