---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/engine-workorder': patch
'@substrat-run/engine-booking': patch
---

A refused lifecycle move is now recorded. When an operation fails because `assertTransition` refused the move, the kernel writes the attempt to its own table after the rollback, the way a denied permission is recorded. The row holds the record, the state it was in, the operation, where that operation leads when it is legal, who tried, and in which call.

`assertTransition` takes the record as an optional last argument (`{ entityType, entityId }`), and the work-order and booking engines now pass it. The HTTP response to a refused move is unchanged.

The process map's lifecycle read now also returns the window's refused moves.
