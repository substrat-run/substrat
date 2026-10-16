---
description: "Attachments: files hung on an entity, gated by its own permissions. Upload links let an operation mint a single-use URL so a caller with no session uploads one file without bytes in a tool call."
---

# Attachments

An attachment is a file hung on one entity. The metadata fact lives in the scope's own database,
in `_substrat_attachments`, written in the same transaction as an `attachment.added` event. The
bytes go to the tenant's blob store and never through `invoke`. A vertical opts an entity type in
with `attachmentTargets` in its manifest:

```ts
attachmentTargets: [
  { entityType: 'contract', readPermission: 'contract:read', writePermission: 'contract:write' },
],
```

`readPermission` gates list and open. `writePermission` gates upload and remove, and defaults to
the read key. Both are checked **on the owning entity**, so an entity-narrowed grant resolves
exactly as it does for `ctx.check`.

The attachment surface is on the host, not on `ctx`: `host.attachments(principal, tenantId,
scopeId)` returns `upload`, `list`, `open`, `remove` and `search`. **The platform ships no
upload route.** A vertical mounts its own, calls `upload` with the bytes, and decides what the
platform does not: the size cap, which file types it accepts, any scanning. The kernel itself
checks the write key and records the file. For a link share's read-only door, see
[Permissions](./permissions.md#files-through-a-link).

That leaves one gap. An [MCP](./mcp.md) client calling an operation has no cookie and often no
bearer for the vertical's own route, and a file of any real size cannot go through a tool call
as base64. Upload links close it.

## Bytes that no row points at

The bytes go to the store before the row is written, so a few paths leave an object that no row
names: a crash between the two, a call to the scope that fails in transport (the platform cannot
tell whether the row committed, so it keeps the bytes rather than risk a row without its file),
and a point-in-time rewind past a row. Nothing reads such an object, but it costs storage and the
storage meter counts it. The platform's **orphan sweep** deletes it, under four guards. Each one
alone stops a row that committed from losing its bytes:

- **A tombstone first.** The scope never deletes. It records each candidate that no row names as
  condemned, in one transaction, and an attachment insert refuses a condemned id in its own
  transaction. The scope serializes the two, so either the row commits first and the sweep sees
  it, or the tombstone commits first and the upload fails with `conflict`
  (`attachment_condemned`). Only a condemned object is deleted. No clock is involved, so a slow
  upload, a retried call or a skewed clock cannot turn a committed row into a deleted object. A
  restore whose dump would bring back a row for a condemned id is refused the same way.
- **An age floor.** Only an object whose id was minted more than seven days ago is judged. The id
  is a ULID minted just before the bytes are written, so an upload still in flight is never
  condemned in the first place.
- **A restore fence.** A Durable Object keeps 30 days of point-in-time history, so a row that a
  rewind or a restore took away can be brought back for that long. Every rewind and every restore
  of a scope first writes a fence object into the tenant's blob store, and the sweep deletes
  nothing of that scope until the fence is 35 days old. The fence lives in the blob store, not in
  the scope, because the rewind it records would erase it there. The sweep reads the fence before a
  pass and again after the condemnation, just before the first delete, so a rewind that lands
  mid-pass stops the deletes. A fence it cannot read counts as a fence.
- **The scope itself judges.** Only the copy that holds the scope's rows may say which objects are
  orphans. A copy that a carry wiped or kept, a fork, a snapshot, and a scope with no record that
  it was provisioned for the tenant all refuse. Any of those would read every object as an orphan.

A pass lists only the scope's own attachment keys (`scope/<scopeId>/att/<ulid>`). Other scopes'
keys, other features' keys and anything malformed in the same bucket are never judged. A dry run
condemns and deletes nothing and reports the keys a pass would delete.

**A restore refuses when its fence cannot be written.** This is a deliberate trade of
availability for safety: a rewind or a restore whose fence did not land could hand the sweep a
state that lacks rows a later restore brings back. The refusal says so, and nothing has been
replaced, so retry once the attachment store answers. A rewind also needs to know whose bucket to
fence. The control plane names the tenant, and otherwise the scope's own provision receipt does.
A scope that has neither is refused until it is reconciled.

**What the sweep cannot protect.** A restore from a dump older than 35 days can bring back rows
whose bytes were swept. A removed attachment has the same exposure today, since removing it
deletes its bytes. Restore from a dump younger than that, or expect some of its files to be missing.

## Upload links

An operation mints a **single-use, short-lived URL that admits one file to one entity**. The caller
sends the bytes to that URL directly, with `curl`, and nothing else.

### Declare it

The target says it takes links, and what a link may admit:

```ts
attachmentTargets: [
  {
    entityType: 'contract',
    readPermission: 'contract:read',
    writePermission: 'contract:write',
    uploadLinks: { maxBytes: 15 * 1024 * 1024, contentTypes: ['application/pdf', 'image/*'] },
  },
],
```

Declaring `uploadLinks` is the opt-in. A target without it refuses a mint. `maxBytes` is required
and held under 25 MiB. `contentTypes` is an allowlist of media types or families. A mint may only
narrow the size, and the declaration appears in the vertical's `PERMISSIONS.md` under *Upload
links*, so widening it is a reviewed diff.

**A family never admits an active type.** `image/*` admits PNG, JPEG and the rest, but not
`image/svg+xml`. `text/*` admits plain text and CSV, but not `text/html`. Active means HTML,
`text/xsl` (which Chrome parses as HTML even under `nosniff`), `multipart/x-mixed-replace` (whose
parts WebKit renders as documents, also under `nosniff`), the types a browser sniffs for
HTML (`application/unknown`, `unknown/unknown`), every XML type (`text/xml`, `application/xml` and any subtype ending in `+xml`, such as
`image/svg+xml`, `application/xhtml+xml` or `application/rss+xml`), and every JavaScript MIME
type the WHATWG MIME Sniffing standard lists (`text/javascript`, `application/javascript`,
`application/x-javascript`, `text/ecmascript` and the rest). A browser runs these instead of
showing them, and the person holding the link chooses the bytes. The type is judged as its
essence, without parameters, spaces or capitals, so `image/svg+xml; charset=utf-8` is still SVG,
and `image/jpg` is judged and recorded as `image/jpeg` (so an allowlist entry spelled `image/jpg`
never matches; write `image/jpeg`). A type that is not exactly one `type/subtype` (a list such as
`image/png,text/html`, which a browser reads as its last type; `text/html,x` or `text/html x`,
read as `text/html`; one with a control character; or a wildcard such as `*/*` or `image/*`, which
is an allowlist entry and never a file) is refused by every allowlist, including an absent one. To take an active type, name it exactly:

```ts
uploadLinks: { maxBytes: 2 * 1024 * 1024, contentTypes: ['image/*', 'image/svg+xml'] },
```

::: warning Serve stored files as downloads, whatever the allowlist
Any route of yours that serves an attachment should answer with all three of
`X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` and a sandboxing
`Content-Security-Policy` (`default-src 'none'; sandbox`), as the platform's link-share download
does, so a stored file is never run as your origin. The active-type rule is a second line, not the
first: leaving `contentTypes` out admits every well-formed type, active ones included, and an
exact entry admits the type it names. The rule was checked against Chrome and WebKit; Firefox was
not covered.
:::

### Mint it, in an operation

```ts
'contract/upload-link': async (ctx, input) => {
  assertAllowed(await ctx.check('contract:write', ref));      // your own guards first
  if (await isLocked(ctx, input.contractId)) throw substratError('conflict', 'the contract is locked');
  const link = await ctx.attachments.mintUploadUrl({
    entity: ref,                       // { entityType: 'contract', entityId }
    filename: 'signed-contract.pdf',   // optional: fixes the stored name
    maxBytes: 10 * 1024 * 1024,        // optional: narrows the target's
    ttlSeconds: 300,                   // optional: default 600, at most 3600
  });
  return { url: `${PUBLIC_ORIGIN}${link.path}`, expiresAt: link.expiresAt };
},
```

`mintUploadUrl` checks the target's `writePermission` on the entity, as the caller, so a caller
without it is refused even if the operation forgot its own guard. Only a principal can mint or
revoke. A schedule, a connector or a consumer holds no authorship to lend, and is refused with
`forbidden` and reason `upload_link_delegation`. The result is
`{ id, secret, path, expiresAt, maxBytes, filename }`. `path` is
`/api/attachment-uploads/<entityType>/<entityId>/<secret>`, and the origin is yours to put in
front of it.

### Upload with it

```sh
curl --upload-file signed-contract.pdf \
  "https://crm.example/api/attachment-uploads/contract/01J…/sbup_…?filename=signed-contract.pdf"
```

```json
{ "id": "01K…", "filename": "signed-contract.pdf", "contentType": "application/pdf",
  "size": 482113, "sha256": "…" }
```

Mount the route once, beside your others:

```ts
import { mountUploadLinkRedeem } from '@substrat-run/vertical-host';

mountUploadLinkRedeem(app, { host: () => host, node: (c) => nodeOf(c) });
```

`PUT` and `POST` both work. The file name comes from the link if it fixed one, else `?filename=`,
else `Content-Disposition`, else `upload`, and is always a leaf name, never a path. The media type
is the request's `Content-Type` unless that is absent or generic (`curl --upload-file` sends
none), then the extension, then the bytes. For PDF, PNG, JPEG and GIF the bytes must agree with
the claim, so a PNG called `contract.pdf` is refused.

| Answer | When | Spends the link? |
|---|---|---|
| **201** | the file is stored | yes |
| **404** | the secret names nothing or is not shaped like one, or the path names another entity or type than the link was minted for (whatever the link's state) | no |
| **410** | the link was used, has expired or was revoked, asked for at its own path | n/a |
| **413** | the body is over the link's size, judged by `Content-Length` and again as bytes arrive | no |
| **415** | the type is not admitted, or the bytes contradict it | no |
| **403** | the minter no longer holds the write key | no |
| **400** | an empty body | no |

A refusal never spends the link: the caller can fix the file and send it again within the time
box. A malformed secret is answered by the route without the scope being asked, with the same
404 an unknown one gets. The route listens at `/api/attachment-uploads/…` only, the path the
mint returns.

### What it is, and is not

- **It is the platform's upload, not a second one.** The route hands the bytes to
  `ScopeHost.redeemUploadLink`, which writes them through the same attachment write as any
  upload. The bytes go to the blob store, then the row and `attachment.added` land in one scope
  transaction. The **author is the principal who minted the link**, and the target's
  `writePermission` is checked as them **again at redemption**, so revoking their access ends
  what their links can do.
- **Single use is the transaction's.** The link is marked used in the same transaction that
  inserts the attachment row. Two requests racing for one link are serialized by the scope and
  the second one gets 410. A redemption that fails anywhere leaves the link unspent.
- **The secret is the authority.** 256 random bits, `sbup_`-prefixed so a secret scanner can
  recognise one. Only its SHA-256 is stored. An operation that tries to persist the secret in
  an event, its own table or a platform intent is refused, the same tripwire `ctx.capabilities`
  has.
- **It is bound to one target and one scope.** The target is in the path as well as in the link,
  so a URL pasted onto another entity is a 404 that spends nothing, and it is the same 404 whether
  the link is still pending or already spent. A link is not found in any other scope, of your
  tenant or another.
- **It never acts.** A link is not a [capability](./permissions.md#sharing-by-link-capabilities): it has
  no session, acts as nobody and can only ever produce the one attachment it was minted for.
- **Your own locks are checked at mint, not at redemption.** An entity lock or state check in the
  operation runs before the mint. The platform does not know it and cannot run it again later, so
  keep `ttlSeconds` short, and revoke a link whose entity is locked after it was minted. It also
  does not check that the entity exists, which is true of an ordinary upload too.
- **The platform does not scan.** The type check is the allowlist, the active-type rule for
  families, and the four sniffed formats. Anything stronger is the vertical's, in a consumer of
  `attachment.added`.

### Find the file afterwards

Three ways, all carrying the attachment id so a follow-up operation can be called with it:

- the **upload's own answer**, which the caller already has in hand;
- the `attachment.upload-link-redeemed` event, written in the same transaction as
  `attachment.added` and carrying `{ linkId, attachmentId, entity, size, sha256, mintedBy }`, which a
  consumer can use to run the follow-up itself;
- `ctx.attachments.uploadLinks({ entity })`, whose records say `pending`, `redeemed`, `revoked` or
  `expired` and, once redeemed, the `attachmentId`.

`ctx.attachments.revokeUploadLink(id)` takes back a link that has not been used. The mint, the
revoke and the redemption are each on the spine as `attachment.upload-link-minted`,
`attachment.upload-link-revoked` and `attachment.upload-link-redeemed`. They are kernel-authored,
so module code cannot forge or suppress them.

### Things that will bite you

- **The secret is in the path.** A header-only secret could not be used with `curl --upload-file URL`
  alone. What contains the cost: a link lives ten minutes by default and an hour at most, it is
  single-use, and `invocationLog` writes the secret segment, and any path segment that starts with
  `sbup_`, as `[redacted]`. A log the *runtime*
  keeps of full request URLs (Workers Logs, a proxy in front of the vertical) can still hold an
  unused link until it expires. Do not keep such a log for longer than the link lives.
- **CORS.** The route sends no CORS headers and removes the ones an outer layer set. A blanket
  `app.use('*', cors())` therefore cannot make the answer readable by a page that learned a
  link. A browser page that really must upload from another origin needs CORS added for this
  path, on purpose. A script, an MCP client's shell and `curl` need none.
- **Validators and echoes.** The answer carries no `ETag`, `Last-Modified` or `Location`, never
  repeats the secret and is `Cache-Control: no-store`, so nothing in it is a handle on the bytes
  or the link. Do not forward the blob store's own `ETag` (for an object store, a hash of the
  content) in a wrapper of your own.
- **Version.** `ctx.attachments` and the `uploadLinks` manifest key exist from the platform
  release that introduced upload links; a vertical that uses them needs that version or newer.
