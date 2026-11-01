# @substrat-run/connector-mail-in

## 0.1.10

### Patch Changes

- Updated dependencies [b8b837b]
  - @substrat-run/contracts@0.174.0
  - @substrat-run/kernel@0.174.0

## 0.1.9

### Patch Changes

- Updated dependencies [77318c1]
  - @substrat-run/kernel@0.173.0
  - @substrat-run/contracts@0.173.0

## 0.1.8

### Patch Changes

- Updated dependencies [e8e51ba]
- Updated dependencies [279c6f3]
- Updated dependencies [06c306f]
  - @substrat-run/contracts@0.172.0
  - @substrat-run/kernel@0.172.0

## 0.1.7

### Patch Changes

- Updated dependencies [2c7b3a7]
- Updated dependencies [e3f11a8]
  - @substrat-run/contracts@0.171.0
  - @substrat-run/kernel@0.171.0

## 0.1.6

### Patch Changes

- Updated dependencies [f0e000d]
- Updated dependencies [0bc0f4a]
  - @substrat-run/contracts@0.170.0
  - @substrat-run/kernel@0.170.0

## 0.1.5

### Patch Changes

- Updated dependencies [9e6412c]
- Updated dependencies [77d504f]
- Updated dependencies [fb2de85]
  - @substrat-run/contracts@0.169.0
  - @substrat-run/kernel@0.169.0

## 0.1.4

### Patch Changes

- Updated dependencies [e34da92]
  - @substrat-run/contracts@0.168.0
  - @substrat-run/kernel@0.168.0

## 0.1.3

### Patch Changes

- Updated dependencies [280f175]
  - @substrat-run/contracts@0.167.0
  - @substrat-run/kernel@0.167.0

## 0.1.2

### Patch Changes

- Updated dependencies [9499b29]
  - @substrat-run/contracts@0.166.0
  - @substrat-run/kernel@0.166.0

## 0.1.1

### Patch Changes

- Updated dependencies [7df34ee]
  - @substrat-run/contracts@0.165.0
  - @substrat-run/kernel@0.165.0

## 0.1.0

### Minor Changes

- 3225234: Inbound mail (#2611). A scope can have an address on the platform's receiving subdomain (`in.substrat.run`) that mail is forwarded to, and each message lands through the operation its vertical declares (`connections: [{ provider: 'mail-in', operation, permission }]`), with attachment bytes stored on the entity that operation answers. Each address is its own `mail-in` connection: granted the declared key on its one scope, rotatable (mail in flight moves to the new address) and revocable, and the actor of everything a delivery writes. Unknown or revoked addresses, messages over 25 MiB and senders off an address's allowlist are refused at SMTP time; an allowlisted sender must be proven by DMARC/DKIM for `From:` or SPF for the envelope, read from the receiving MX's own stamp only. Accepted mail is stored before the SMTP answer, deduplicated on `Message-ID`, delivered straight away and retried by the connector pass, and dead-lettered after eight attempts. contracts: `mailInChange`, `mailInMessageAnswer`, `mailInAddress`, the relay shapes and limits. vertical-host: `mailInAddress` asks for, reads, rotates or revokes the scope's address from the vertical's worker (a proven caller is required).

### Patch Changes

- Updated dependencies [170078f]
- Updated dependencies [3225234]
- Updated dependencies [0e2bc1c]
- Updated dependencies [0b19237]
- Updated dependencies [2ade7ea]
- Updated dependencies [af79679]
- Updated dependencies [1e5a5af]
  - @substrat-run/contracts@0.164.0
  - @substrat-run/kernel@0.164.0
