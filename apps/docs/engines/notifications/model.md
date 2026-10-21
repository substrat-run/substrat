# Domain model & invariants

| Table | Owns |
|---|---|
| `notifications_topics` | Each used topic's description and required flag |
| `notifications_recipients` | One address per principal |
| `notifications_mutes` | Disabled topics per principal and channel |
| `notifications_deliveries` | One delivery per dedupe key, topic, principal and channel |
| `notifications_cadences` | Topics a principal takes as a daily digest |
| `notifications_digest_items` | Rendered messages held for a digest |

A delivery starts `requested` or `skipped`. Platform outcomes settle a requested
send as `sent`, `refused` or `dead_lettered`. Held occasions are `skipped`/`digest`;
the digest is a separate delivery under the reserved topic `@digest`.

Subject erasure deletes addresses and held messages and cancels pending send
intents. The delivery ledger contains no address or rendered message.

## Guarantees

<CommunicationFlow kind="notifications" />

- **One delivery record per occasion and recipient.** A delivery is unique on (dedupe key,
  topic, person, channel), and a redelivered event finds its row instead of creating another
  send intent. Provider delivery is still at-least-once: if the provider accepts a message
  but recording the outcome fails, a retry can send the message again.
- **A mail is never sent blank.** A placeholder with no variable makes `notify` throw, which
  rolls back your transaction. From a consumer, the event dead-letters with the reason.
- **A value cannot be turned against the reader.** Variables are HTML-escaped in the HTML part
  and kept to one line in the subject.
- **A mute holds, except where it must not.** A topic passed as `required` cannot be switched off.
- **A digest is the person's choice, per topic.** A topic someone takes as `daily-digest` is
  held. Once their oldest held message is a day old, they get one mail of up to 50 held
  messages, tracked as one delivery. Nothing waits much longer than a day, and unless more than
  50 are held, that is one digest a day. A
  mute still wins over a digest, and a required topic always goes out at once. The digest adds
  no wording of its own: one held message goes out as it is, and several go out under the first
  one's subject with `(+N)`, each under its own subject, as one document.
- **A digest never crowds out mail that must not wait.** A scope holds a limited number of
  sends waiting for the platform. A digest pass takes at most the room left, less a reserve for
  immediate mail, and the rest goes out on the next passes.
- **A digest is bounded.** It carries at most 50 messages, oldest first. Any more follow in a
  later digest, once the oldest of them is a day old.
- **One person's trouble stays theirs.** A digest that cannot be written stays held and is
  reported, and never stops anyone else's. A held message that no longer reads is set aside
  and reported, so it never holds up the rest of that person's digest. It is read again daily
  and goes out once it reads, unless its topic has been switched off since.
- **A mute is checked again at send time.** A held message whose topic is switched off is
  withdrawn, never mailed, however it came to be held.
- **A person reads their own history, and only theirs.** `notifications/my-deliveries`, under
  `notifications:self`, pages the caller's deliveries, newest first. It takes no principal, so
  holding the key never reaches anyone else's rows. Its rows leave out the idempotency key and
  the platform's send-intent id, and show a `reason` only for a skipped delivery (muted, no
  address, held for a digest, or set aside as unreadable). The platform's outcome code on a refused or dead-lettered send is
  left to whoever reads the whole log.
- **An address never rides an event.** It lives on the engine's recipient row, which a subject
  erasure deletes. The same erasure cancels a send that is still held.
