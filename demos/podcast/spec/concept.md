# Podcast hosting — concept

Status: draft v0.1 · Last updated: 2026-10-19 · For review before any code

## 1. What we're building & who uses it

A hosting platform for podcast **publishers** (networks or single creators). Each publisher is
its own workspace with a set of **shows**. The publisher invites its own **members**; for now
every member has the same access. Members upload episodes, attach transcripts, schedule ads and
schedule publication. The platform encodes the audio, bakes the scheduled ads into it, and serves
a public **RSS feed per show** following the Podcasting 2.0 namespace. Publishers pay us for
hosting by card. Advertisers do not log in and ads are paid for outside the system.

## 2. The thing that moves through the system

The **episode**. Its lifecycle, with the moves that must not be skippable:

`draft → processing → ready → scheduled → published`, plus `unpublished` (taken down).

- `processing`: the source audio is being encoded and the ads baked in. An episode cannot reach
  `ready` without a finished encode that matches its current ad placements.
- `ready → scheduled` needs a publish time; `scheduled → published` happens at that time (or by
  "publish now" from `ready`). Nothing reaches `published` without passing through `ready`.
- Changing an ad placement or replacing the source audio on a `ready`/`scheduled` episode sends it
  back to `processing` (a re-bake). On a `published` episode it creates a new encoded version; the
  feed `guid` never changes.

A second, smaller flow: an **ad flight** (a campaign's run on chosen shows between two dates)
becomes concrete **placements** in episodes that publish while the flight is live.

## 3. What already exists vs. what's yours

**The platform gives you, free:** a workspace per publisher with hard isolation; members and
invitations; permissions with a recorded reason for every decision; a tamper-proof history of
every change (who published what, who moved an ad); append-only migrations; file storage for audio.

**Existing building blocks we compose:**
- *Invites* — adding members to a publisher.
- *Metering* (optional, later) — counting storage and downloads against a hosting plan.
- *Notifications* (optional) — "your episode is live" / "encoding failed".

**Not covered by anything existing — we build it:**
- Shows, episodes, people, chapters, transcripts, the episode lifecycle above.
- Campaigns, flights, ad creatives and the placement rules.
- The Podcasting 2.0 RSS renderer and its public, cached feed route.
- **Encoding / ad baking** and **transcription**: these run in an outside service, never inside
  the app's own transaction. The app records the request, an external worker does the job, and the
  result comes back and is recorded. This needs a new *connector* for whichever encoder and
  transcription provider you choose (none exists today).
- **Card billing** for hosting: also an outside provider and a new connector (see §9).
- Scheduling: "publish at", and "flight starts/ends". The platform runs periodic sweeps that pick
  up due work; the exact granularity is confirmed during the build — assume publishing is accurate
  to about a minute, not a second.

**Honest limits.** The platform stores the data and makes the decisions; it is not the audio byte
path. Serving MP3s to listeners and counting downloads is a CDN/edge job that sits beside it.
Dynamic (request-time) ad insertion is therefore out of scope for v0.1.

## 4. Who is denied what

One role at first, so the interesting denials are *between publishers* and *the public*:

| Who | Can | Cannot |
|---|---|---|
| Member of publisher A | Everything inside publisher A: shows, episodes, ads, transcripts, members | See anything of publisher B — it does not exist for them |
| Member of publisher B | Same, inside B | See anything of A |
| Anonymous listener / podcast app | Read the public feed and audio of **published** episodes | Read drafts, scheduled or unpublished episodes, ad campaigns or placements, members; change anything |
| An invited-but-not-accepted person | Nothing | Everything, until they accept |

**Who can see the money?** Ads are paid outside the system, so we store no rates, prices or
payouts. The only money is the publisher's own hosting subscription, visible to its members.
**Who can see other customers' data?** Nobody: another publisher's workspace is unreachable, not
merely hidden. The feed shows listeners published episodes only; ad placement details are never in
it (the ads are part of the audio).

Deliberately deferred: a role split (e.g. editor vs ad-sales vs owner). Adding one later is a
change to roles, not to the data.

## 5. Money & sign-off

- **Hosting subscription:** publishers pay by card. No invoices. The app stores the plan and its
  status; the card provider owns the card.
- **Ads:** no money in the system.
- **Sign-off:** none required for v0.1 beyond the lifecycle gates in §2. (An approval step for
  sponsor reads is a natural later addition.)

## 6. The cast, roles, and tenancy

- Role: `publisher-member` — full access inside its own publisher. (The first person to claim a
  new publisher is its owner; ownership transfer and removal rules are an open decision.)
- Workspaces: **two publishers, always** — `acme-audio` (the one we use) and `tenant-b` (exists to
  be attacked).
- One workspace per **publisher**, with shows inside it. (Not one per show: a campaign or a member
  list spans a publisher's shows.)
- Demo cast: `ada` and `ben` in `acme-audio`; `cleo` in `tenant-b`; plus the anonymous listener.

## 7. The data we'll store

Plain terms; this previews the migration diff.

- **Member profile** — display name, email, linked to the login. *(Source of every human name
  shown in the app and any "uploaded by …" line.)*
- **Show** — title, slug, description, language, category, artwork, owner/author name, explicit
  flag, `locked`, a permanent feed `guid`, optional funding links, optional value/payment block.
- **Person** — name, URL, image (hosts and guests; source of `podcast:person`).
- **Episode** — show, title, description, season/episode number, type (full/trailer/bonus),
  explicit flag, status, `publish_at`, `published_at`, a permanent episode `guid`.
- **Episode person** — which person, with which role (host/guest/…), on which episode.
- **Chapter** — episode, start time, title, optional image/URL.
- **Source audio** — episode, the uploaded file, size, content type.
- **Encoded audio** — episode, version number, the file served to listeners, byte length,
  duration, content type, which placements were baked in. Older versions are kept.
- **Encode job** — episode, what was requested, state, attempts, last error.
- **Transcript** — episode, language, format (VTT/SRT/JSON/HTML), file, how it was produced
  (uploaded or generated), state.
- **Advertiser** and **Campaign** — name and notes only; no rates.
- **Ad creative** — campaign, audio file, length.
- **Flight** — campaign, shows targeted, start and end date, positions allowed (pre/mid/post).
- **Placement** — episode, flight, creative, position and offset, state.
- **Feed snapshot** — show, rendered XML, a version tag, when it was built. *(What the public
  route serves; rebuilt when a show or its published episodes change.)*
- **Subscription** — plan, status, period end, provider reference.

Every name shown in the feed (`podcast:person`, author, owner) comes from **Show** or **Person**;
every name shown in the app comes from **Member profile**.

## 8. The scenario the test will replay

1. `ada` (acme-audio) creates a show, adds a host, uploads episode audio, adds a transcript.
2. She creates a campaign and a flight covering the show; placements are created for the episode.
3. The episode is encoded (simulated) and reaches `ready`; she schedules it for a time.
4. Time passes (test clock): the episode publishes; the feed now contains it with the Podcasting
   2.0 tags (guid, person, transcript, chapters, locked, season/episode); before that time it did not.
5. `ada` changes an ad placement on a ready episode: it returns to `processing`; it cannot be
   published until re-encoded.
6. **Denials:** an episode cannot be scheduled before it is `ready`; `cleo` (tenant-b) sees none of
   acme-audio's shows, episodes or campaigns, even by id; the anonymous listener gets the feed for
   published episodes only and is refused drafts, campaigns and writes; an un-accepted invitee
   can do nothing.

## 9. Open decisions

| Decision | Recommended default |
|---|---|
| Sign-in | Local dev signs in through the dev issuer. For real use, a separate OIDC issuer; the app only trusts it. |
| Deploy or stay local | Stay local first. |
| Encoder and transcription providers | Pick one of each so the connector has a concrete target; the app only records requests and results. |
| Card billing | Defer past v0.1 and use the provider's hosted checkout and portal; the app mirrors plan status from the provider's webhooks. |
| Workspace unit | One per publisher (§6). |
| Ownership | First claimant is owner; members can be removed by any member in v0.1 — likely too loose; confirm. |
| Feed freshness | Rebuild the snapshot on change and at publish time; serve with ETag and short cache. |

## 10. Out of scope / deferred

Dynamic ad insertion; ad pricing, billing or payout; advertiser logins and reports; download
analytics; listener subscriptions or private feeds; roles beyond `publisher-member`;
import from existing feeds; live-stream (`podcast:liveItem`); Value-for-Value payment flow beyond
storing the `value` block.

## Review questions for the human

1. Is "everyone in a publisher can do everything, including removing other members" acceptable for
   v0.1, or do you want an owner/member split from the start?
2. Is one workspace per publisher right — or must a publisher be able to give a person access to
   only one of its shows?
3. Is a re-bake of an already-published episode (new audio at the same guid) something you want
   members to do freely, or should it need a deliberate confirmation?
