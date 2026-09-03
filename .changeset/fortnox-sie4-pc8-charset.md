---
'@substrat-run/connector-fortnox': minor
---

Fortnox: read SIE4 as PC8/CP437, and tolerate the nulls a real company sends

The first live run against a real Fortnox company disproved two claims this connector
had been carrying on documentation alone.

**The SIE4 export is PC8 (code page 437), not ISO-8859-1.** The file declares it in
`#FORMAT`; the HTTP response does not. Decoding it as latin1 does not throw and produces
no replacement character — every byte 0x00–0xFF is a valid latin1 code point — so every
Swedish letter in every account name came back wrong, silently: `för` arrived as `f”r`.
The whole package stayed green through this because `FortnoxMock` encoded latin1 too, so
the reader and the fixture agreed with each other while both disagreed with Fortnox.

Decoding now lives in `decodeSie`, which reads `#FORMAT` and refuses a charset it does
not implement rather than guessing. `TextDecoder` is no help here: CP437 is not in the
WHATWG Encoding registry, and `TextDecoder('iso-8859-1')` is really windows-1252, which
differs from latin1 in exactly the range CP437 keeps its Swedish letters in — so the
decoder carries its own table for 0x80–0xFF.

**`companyinformation` sends explicit `null` for unset text.** `.optional()` permits an
absent key, not a null one, so the response parse threw for any company with a blank
address — which would have broken the connect-time probe rather than the sweep, i.e. at
exactly the moment an operator is trying to verify a new connection. Text fields are now
null-tolerant, and `DatabaseNumber` normalizes null to undefined because callers test
`=== undefined` before stringifying it, and `String(null)` is the tenant id `"null"`.

**Breaking:** `latin1Bytes` is now `pc8Bytes` and encodes CP437. Anything building SIE
fixtures against the mock encodes the way Fortnox actually does.

Also adds `pnpm fortnox:seed`, which puts a financial year and balanced vouchers into a
sandbox so the live suite has something to read. It refuses to write to any company whose
organisation number is not Fortnox's sandbox marker `555555-5555`: the live suite is
read-only by design, which is what makes it safe to point at production books, and the
writing must never move into it.
