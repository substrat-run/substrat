# Microsoft 365 (mail and channel documents)

Sends mail **as your organisation's own addresses** through Microsoft Graph, with an app
registration in your own Entra directory. It sits behind the platform's email relay: an app that
sends with a `from` address your connection covers sends through your mailbox, and everything
else still goes out from the platform's own address.

It also keeps **documents in one Teams channel's folder**: an app can save files into the
channel, and files people add, rename or delete in Teams reach the app. Nothing outside that
folder is read or written.

::: warning Not yet verified against a live tenant
The connector is checked against a stand-in for Entra's token endpoint and Graph: the
certificate is parsed and its signature verified by an independent X.509 implementation, and
every answer Entra or Graph can give is sorted into "refused" or "not yet". Channel documents are
checked against a stand-in document library with a change feed. What a stand-in cannot prove is
that Microsoft accepts these shapes. Until a real send and a real channel sync have run, treat the
setup below as written from Microsoft's documentation, not from a run.
:::

## At a glance

| | |
|---|---|
| **Provider** | Microsoft 365 — Microsoft Graph, app-only (client credentials) |
| **Category** | Mail, and documents in one Teams channel |
| **Status** | **Built, not yet live-verified** |
| **Package** | `@substrat-run/connector-microsoft365` (not published yet) |
| **Sends** | through the email relay, for a `from` address the connection covers |
| **Documents** | one standard channel's folder, bound to one scope; written on request, read by a periodic sync |

## Least privilege, on your side

Nothing here asks for access to the whole organisation:

- **Mail**: the app may send only as the addresses you choose, granted in Exchange Online with
  RBAC for Applications. It cannot read anyone's inbox.
- **Documents**: the app holds `Sites.Selected` and reaches only the SharePoint site you grant it.
- **No user signs in** and no password is shared. Disabling the app under **Enterprise
  applications** stops everything at once.

## Setting it up

You need Global Administrator, or Application Administrator + Exchange Administrator +
SharePoint Administrator. Plan for 30–60 minutes, plus up to two hours for Exchange to apply
the mail scope.

### 1. Register the app in Entra ID

1. **Entra admin center → Applications → App registrations → New registration.** Name it so you
   recognise it (the name appears as "modified by" on files it writes). Accounts in this
   organisational directory only; no redirect URI.
2. **API permissions → Add a permission → Microsoft Graph → Application permissions →
   `Sites.Selected`**, then **Grant admin consent**. Do **not** add `Mail.Send`,
   `Mail.ReadWrite`, `Files.ReadWrite.All` or `Sites.ReadWrite.All` — those reach the whole
   organisation. Mail is granted narrowly in step 2.
3. Note the **Application (client) ID** and **Directory (tenant) ID**.
4. Under **Enterprise applications**, find the app and note its **Object ID** (the service
   principal's, which differs from the registration's).

### 2. Mail: scoped send rights in Exchange Online

Choose the sender mailbox (a shared mailbox works and needs no licence), then in Exchange Online
PowerShell:

```powershell
New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> -DisplayName "Substrat"

New-ManagementScope -Name "Substrat-senders" `
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'noreply@your-domain.com'"

New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.Send" `
  -CustomResourceScope "Substrat-senders"
```

For several sender addresses, scope to a mail-enabled security group instead
(`MemberOfGroup -eq '<group DistinguishedName>'`) and manage senders by membership. Check the
scope once it has taken effect:

```powershell
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource noreply@your-domain.com   # InScope = True
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource someone.else@your-domain.com  # InScope = False
```

Exchange allows about 30 messages a minute and 10 000 recipients a day per mailbox — enough for
notifications and documents, not for bulk mail.

### 3. Grant the SharePoint site

Use a **standard** channel (private and shared channels have sites of their own). Find the site
URL from the channel's **Files → Open in SharePoint**, then grant the app `Write` on that site:

```powershell
Grant-PnPEntraIDAppSitePermission -AppId <client-id> -DisplayName "Substrat" `
  -Site https://your-tenant.sharepoint.com/sites/TeamName -Permissions Write
```

`Write` lets the app save files into the channel. If you only need mail, `Read` is enough: the
connector then only reads the site to confirm the connection reaches it.

The site grant covers the whole site. The connector narrows it to the one channel folder you bind
(below), and refuses anything outside it on its own side, even if more is added to the site later.

### 4. Connect it in the dashboard

Open the app's **Integrations**, choose **Microsoft 365**, and enter the directory ID, client ID,
sender addresses and site URL.

- **With a certificate (recommended):** leave the client secret empty. The platform generates a
  keypair for this connection and keeps the private key; open the connection and **Download
  certificate**, upload it under **Certificates & secrets → Certificates**, then **Test
  connection**. The thumbprint Entra shows should match the one on the connection.
- **With a client secret:** create one (at most 12 months) and paste it.

**Test connection** signs in and reads the site. "The certificate is not on the app registration
yet" or "no access to the site yet" mean a step above is still to do; the connection is saved
either way.

Mail cannot be tested without sending, because the app cannot read a mailbox. So each sender
address reads **not verified** until a message from it goes out, and then **verified**, with the
day of its last send. To check an address before your app sends anything, open the connection and
use **Send a test message**: pick a sender address, and one short message goes from it to your own
address. If Exchange refuses it, the connection says why: the address is outside the scope you
granted (or the grant has not taken effect yet), the mailbox is being throttled, or the sign-in
failed.

## Documents in a Teams channel

A channel's **Files** tab is a folder in the team site's default document library. You bind that
folder to one scope of your app, and from then on:

- **Your app saves files into the folder.** It names the files and a target directory under the
  folder, states each file's size, and says what happens when a name is taken: `replace`, `rename`
  or `fail`. Files of up to 4 MB go in one request, larger ones by upload session, up to 50 MB each
  and 100 MB per request; a request over either, by the sizes it states, is refused before any file
  is read. Files are sent one at a time, each read as it is uploaded rather than held whole. A stated
  size that is not the file's own is refused too, when that file is opened and before any of it is
  sent. A file whose bytes fail their integrity check while they are read is never saved: a file of
  up to 4 MB is checked before it is sent, and the upload of a larger one is cancelled before it
  completes. The request is then retried, like any failed one.
- **Files people change in Teams reach the app.** A periodic sync reads the library's change feed
  and passes the app every file and folder added, edited, renamed, moved or deleted inside the
  folder. File contents come in as attachments on the record the app keeps for each file, and are
  searchable like any other attachment. A file over 50 MB, or one whose size Microsoft does not
  report, arrives without its contents. A large library is read a few pages at a time, and a folder
  that arrives with contents of its own (one moved in, or the first sync of a nested folder) is read
  a page at a time too, so the first sync of a large or deep folder may take several runs before the
  app has everything.

### Binding the folder

Name the folder by its **path in the document library**, not by the channel's name. For a
channel called *General* that is usually `General`, but the default channel's folder name follows
the team's language, so the two can differ. Open the channel's **Files → Open in SharePoint** and
read the folder name from the address bar.

The app names the operation that receives changes, and the connection must hold that
operation's permission in the scope before the binding is accepted:

```sh
substrat connection bind <connection-id> --scope <scope-id> \
  --operation documents/land-channel-change --permission documents:land \
  --folder General
```

The connection also needs write access to the attachment target that stores the files' contents.

### What the binding guarantees

- **Nothing outside the folder.** A target path with `..`, an empty or absolute segment, a
  backslash, a character SharePoint refuses, or a character that only looks like a slash or a dot
  is refused before Microsoft is called. Writes are addressed relative to the folder itself, and the
  sync passes on only items whose parent chain reaches the folder. Names and details of files
  outside the folder are never stored or logged.
- **Renaming or moving the folder** inside the library keeps the binding, because it is held by the
  folder's id. **Deleting the folder**, or moving it out of the library, stops the binding: syncs and
  writes refuse until you bind again. The binding never falls back to the whole library.
- **A file is saved once.** A retried save does not create a second copy: when Microsoft already
  holds a file under the name, the retry takes it as its own only if this app wrote it and its
  contents are exactly the bytes being saved. Anything else is a conflict — `fail` reports it, and
  `rename` saves under a name with a suffix derived from the request, so a retry aims at the same
  name. One case remains: SharePoint updates some files as it stores them (Office documents get
  their properties rewritten), so if Microsoft's answer to such a save is lost, the retry sees
  different contents — `fail` then reports a conflict, and `rename` saves a second copy.
- **Changes reach the app at least once.** A sync lands each page of the change feed and records
  how far it got, so a sync cut off part-way continues from the last page it finished. A change
  that was being passed on when it stopped is passed on again, so the app's operation must accept
  the same change, or the same contents, twice for one file — keyed by the file's id, which never
  changes.
- **A file is reported deleted only on Microsoft's answer about that file** — the feed saying that
  file was deleted, or a lookup of that file finding nothing. Never because a folder it used to be
  in was deleted, and never because a re-read of the library did not mention it. A file the feed
  shows somewhere the sync cannot place yet (a folder it has not reached), a file under a folder
  the feed shows deleted, and a file a full re-read never mentions are each looked up on their own
  when the sync reaches the end of the feed: not found is reported deleted, outside the folder is
  reported moved out, and still inside stays (and is reported where it now is).
- **A lookup that fails does not stop the folder.** If Microsoft is briefly unavailable or
  throttling, the sync stops with nothing deleted and the next one carries on. If Microsoft refuses
  the lookup itself (no access to that file, or a folder above it that cannot be read), the file is
  kept as it was, never reported deleted, and the sync finishes without it, so new changes keep
  arriving. The binding shows how many files are in that state (a count only).
- **When a refused file is looked up again.** Only when a later sync has reason to: a full re-read
  of the library (after Microsoft expires the sync's position), or a change the feed reports about
  that file. An ordinary sync that does not mention it does not ask again. After three refusals the
  sync stops asking altogether: the file stays as the app last saw it, even if it has since been
  moved out of the folder. Nothing is ever deleted on a refusal. To have such files looked up again,
  fix the access (or the folder above it) in SharePoint, then bind the scope to the same folder
  again: that clears the refusals and re-reads the library in full, which lands nothing for files
  that did not change.
- **A folder's deletion is not its files'.** The app is told a folder was deleted, or moved out, on
  that folder's own answer. A file that was in it and could not be looked up stays where the app
  last saw it; the app should not delete it along with the folder.

## Limits

- **Attachments up to about 2.5 MB in total per message.** Graph's `sendMail` takes attachments
  inline; larger files need a draft and an upload session, which needs `Mail.ReadWrite` on the
  mailbox — the permission this setup deliberately leaves out.
- **HTML body only.** A Graph message has one body; the plain-text part is not sent.
- **Custom headers** must start with `X-`; others are left out.
- **A failed send can be retried.** When Exchange throttles the mailbox (about 30 messages a
  minute) or Graph is briefly unavailable, the connection shows the error, but the next send
  still goes to Microsoft. The first one that succeeds marks the connection healthy again.

## Rotation and revocation

A generated certificate is valid for a year, and its end is the connection's expiry. Editing the
connection's other fields keeps the same certificate.

**Rotating a certificate** never stops mail:

1. **A new certificate is generated beside the current one** when you save the connection within
   30 days of the current certificate's end, or when you tick **Generate a new certificate now**
   while saving. The current certificate keeps signing, and the connection's expiry stays its end:
   that is your deadline.
2. **Download the new certificate** from the connection (**Download new certificate**) and upload it
   under **Certificates & secrets → Certificates**, beside the current one. **Test connection**
   says whether Entra accepts the new one yet.
3. **Save the connection again.** Once Entra accepts the new certificate, the connection switches
   to it and the platform drops the old key. You can then delete the old certificate from the app
   registration. Until Entra accepts the new one, nothing changes: a new certificate that is not
   uploaded yet never affects the one in use.

If you remove the old certificate from the app registration before that save, sends switch to the
new one on their own. If the current certificate lapses before you save, the new one takes its
place at the next save. A new certificate already waiting is kept when you save again, even with
the box ticked, so the one you downloaded stays the one to upload. The save that switches to the
new certificate never generates another one, even with the box ticked: tick it on a later save if
you want to rotate again.

Switching the connection to a client secret drops both certificates and clears the expiry with
them, since Microsoft does not report a client secret's end to the app. Disabling or deleting the
app under **Enterprise applications** revokes everything at once.
