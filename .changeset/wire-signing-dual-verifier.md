---
"@substrat-run/contracts": minor
"@substrat-run/control-plane-api": minor
---

The platform's entry module now carries the wire-signing verifier (RFC wire-signing, step 1), inert until a deployment is given key lists. No upload gives one any yet, so every deployed vertical is served exactly as before: the entry hands the vertical the very request it received and writes nothing new.

Once an upload gives a deployment key lists, the entry reads its state. In `dual` it serves a valid legacy credential as today and counts the envelope beside it, serves an envelope alone as the envelope says, and leaves a request neither proves to the vertical's own checks. In `signed-only` the envelope alone decides, with one fixed refusal for every reason. A fault of the version's own (no nonce store, or key lists that will not load) is counted in `dual` and the request handed on as it came, and answered with one fixed 503 in `signed-only`. Each judged request writes one `{ substrat: 'wire' }` line beside the invocation line.

`@substrat-run/contracts/wire-signing` gains the names a deployment's settings are read from (`WIRE_ROUTER_KEYS_VAR`, `WIRE_PLATFORM_KEYS_VAR`, `WIRE_AUDIENCE_VAR`, `WIRE_STATE_VAR`), `wireStateOf`, `wireEndpoint` (which kind and issuers an endpoint accepts, for the verifier and, later, the signers), `decodeWireEnvelope` (the verifier's own decode, for reading claims before verifying them), a call's body given as a reader (`WireBodyReader`, read only once every cheaper check has passed), and the line's grammar (`WireVerificationLine`, `WIRE_OUTCOMES`, `WIRE_FAULTS`).
