# Runbook: the channel-folder connector against a real Microsoft 365 tenant

This is run by a person with admin rights in a **test** Microsoft 365 tenant (a developer
tenant is fine). It is never run against a customer's tenant. It closes the last "Done when"
item of #2101: until it has run, the connector is checked only against a stand-in for Graph
(`test/fake-drive.ts`), and the public page says so.

`qa/live.mts` runs the connector's own code (the bind, the write dispatch, the sync) on a local
pure-SQLite host, with the real `fetch` and your app registration. Nothing is deployed and the
platform is not involved. The run writes only into a folder of its own, `substrat-qa-<6 letters>`,
inside the channel folder, and deletes that folder at the end.

Credentials are read from the environment, sealed in a temporary directory that is removed when
the run ends, and never printed. The block you paste back holds check names, PASS or FAIL, counts,
change kinds and timings only: no tenant, site, file or folder names. Detail about a failure is
printed to stderr marked `(local only, do not paste)`. Read it yourself, but don't paste it
anywhere public.

Each step says what to expect and what to paste back. The last section maps the checks to
#2101's "Done when" list.

## 0. Before you start

- Node 22 and pnpm 10, and a checkout of this repository.
- In the test tenant: Global Administrator, or Application Administrator plus SharePoint
  Administrator.
- PowerShell 7 with PnP.PowerShell (`Install-Module PnP.PowerShell`), for step 2.
- From the repository root:

```
pnpm install
pnpm build
```

**Expect** both to finish without errors.

## 1. Register the app in Entra ID

1. **Entra admin center → Applications → App registrations → New registration.** Accounts in this
   organisational directory only, no redirect URI.
2. **API permissions → Add a permission → Microsoft Graph → Application permissions →
   `Sites.Selected`**, then **Grant admin consent**. Add nothing else.
3. **Certificates & secrets → Client secrets → New client secret**, with the shortest expiry
   offered. Copy the value now, because it is shown once. (The run signs in with a client secret.
   The platform's certificate path signs in the same way afterwards, and its own tests cover it.)
4. Note the **Application (client) ID** and the **Directory (tenant) ID**.

**Expect** `Sites.Selected` to show "Granted for <your tenant>". **Paste back** nothing.

## 2. A team, two standard channels, and the site grant

1. In Teams, create a team. Use a new one, so the first sync has little to read. Add a second
   **standard** channel beside *General*. Private and shared channels have sites of their own and
   are not what this checks.
2. Open *General* → **Files → Open in SharePoint**. Note the site URL (up to and including
   `/sites/<name>`) and the folder's name in the address bar after `Shared Documents/`. That name is
   the folder's drive path, and it follows the team's language, so it may not read "General".
3. In the **second** channel's Files tab, upload one file with a name you would recognise, e.g.
   `decoy-7c1f.txt`. It is in the same site as the bound folder, so it is exactly what the fence must
   keep out.
4. Grant the app `Write` on the site, and only that site:

```powershell
Connect-PnPOnline -Url https://<tenant>.sharepoint.com/sites/<name> -Interactive
Grant-PnPEntraIDAppSitePermission -AppId <client-id> -DisplayName "Substrat QA" -Site https://<tenant>.sharepoint.com/sites/<name> -Permissions Write
Get-PnPEntraIDAppSitePermission -Site https://<tenant>.sharepoint.com/sites/<name>
```

Instead of PnP you can use `POST /sites/{site-id}/permissions` in Graph Explorer, with `roles:
["write"]` and the app as `grantedToIdentities`.

**Expect** the last command to list the app with the role `write`. **Paste back** the role only.

## 3. Wait for the grant

A new site grant can take a few minutes to apply. If step 5 reads `bind FAIL GraphError 403`,
wait five minutes and run it again.

## 4. Set the environment

In the shell you will run from:

```
export M365_QA_DIRECTORY_ID=<directory (tenant) id>
export M365_QA_CLIENT_ID=<application (client) id>
export M365_QA_CLIENT_SECRET=<the secret value from step 1>
export M365_QA_SITE_URL=https://<tenant>.sharepoint.com/sites/<name>
export M365_QA_FOLDER=<the folder name from step 2>
export M365_QA_DECOY_NAME=<the decoy file's name from step 2>
```

`M365_QA_WAIT_SECONDS` (default 180) is how long the run waits for each change you make in Teams
to show in the change feed.

## 5. Run it

```
pnpm --dir connectors/microsoft365 exec tsx qa/live.mts
```

The first checks run on their own, in a minute or two:

| Check | What it proves on the real tenant |
| --- | --- |
| `fence-bind` | a folder path with `..` is refused, with 0 requests sent |
| `bind` | the folder is found by its drive path and held by its item id |
| `sync-first` | a full pass of the library's change feed completes |
| `write-put` | a 64 KB file goes in one request; SharePoint reports its size, this app as `createdBy.application`, and a `quickXorHash` equal to ours; the bytes read back match |
| `write-session` | the same for a 6 MB file sent by upload session |
| `retry-put`, `retry-session` | the answer to a successful upload is dropped on purpose; the redelivery recognises the file as its own and the folder holds one copy |
| `conflict-fail` | a second event writing the same name with `fail` is refused, and the file is unchanged |
| `conflict-rename` | with `rename`, the second file lands as `name (xxxxxxxx).ext` beside it |
| `conflict-replace` | with `replace`, the file is overwritten in place |
| `sync-own-writes` | the sync brings the run's own files back |

**Expect** `PASS` on each. A `FAIL` is a finding, not a reason to stop. Keep going.

## 6. The Teams steps

The run then asks you to do four things in Teams, one at a time, and press Enter after each. It
syncs until the change arrives, or until `M365_QA_WAIT_SECONDS` runs out.

1. Upload one small file (a text file or a PDF) to *General* itself → `teams-add`: it arrives with
   its contents.
2. Rename that file → `teams-rename`: it arrives as the same item with its previous path.
3. Move it into the folder the run names (`substrat-qa-…`) → `teams-move`: the same, under the new
   path.
4. Delete it → `teams-delete`: it arrives as deleted.

Each line also says whether the bytes were fetched again (`content=…`). A rename or a move is
expected to be `unchanged`; anything else is worth noting, but is not a failure.

Then come `decoy-unseen` (the second channel's file appears in no change and in nothing stored),
`fence-write` (a write to `../outside` is refused with 0 requests sent) and `cleanup` (the run's
folder is deleted and goes to the site's recycle bin).

**Paste back** the whole block between `==== PASTE BACK FROM HERE ====` and
`==== PASTE BACK TO HERE ====`, failures included.

**If a Teams step times out**, run it again with `M365_QA_WAIT_SECONDS=600`. The change feed can
lag. A second run starts clean: it binds again and writes into a new folder of its own.

## 7. Remove everything

1. If `cleanup` failed, delete the `substrat-qa-…` folder in the channel's Files tab.
2. Remove the site grant:
   `Revoke-PnPEntraIDAppSitePermission -PermissionId <id from Get-PnPEntraIDAppSitePermission> -Site <site url>`.
3. In Entra, delete the client secret, then the app registration.
4. Delete the test team, or keep it for the next run.
5. `unset M365_QA_CLIENT_SECRET` (or close the shell).

## What each check answers in #2101

| #2101 "Done when" | Checks |
| --- | --- |
| A file written by a vertical appears in the channel | `write-put`, `write-session`, `conflict-rename`, `conflict-replace` |
| A retried event does not create a second copy | `retry-put`, `retry-session`, `conflict-fail` |
| A file a person adds in Teams arrives through the sync, deletes and renames included | `teams-add`, `teams-rename`, `teams-move`, `teams-delete` |
| A path outside the channel folder is refused before Graph is called | `fence-bind`, `fence-write`, and `decoy-unseen` for the read side (the unit tests in `test/files.test.ts` hold it in CI) |
| Verified against a real tenant | the pasted block, all `PASS` |

Once the block is all `PASS`, the "Not yet verified against a live tenant" warning and the status
line in `apps/docs/connectors/microsoft365.md` come out, in a PR of their own.

## Not covered here: the hosted path

This run is the connector against Microsoft, on a local host. It does not exercise what a deployed
vertical adds around the connector: the vertical's host routing the write event to the platform
(`declareMicrosoft365FilesConnector`), the control plane running the dispatch with the sealed
credential, the connection set up in the dashboard with a generated certificate, `substrat
connection bind --folder`, and the control plane's scheduled sweep. No vertical uses the connector
yet. When one does, this runbook gains a second tier that repeats steps 5 and 6 through it.
