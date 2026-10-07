# Microsoft 365 (mail)

Sends mail **as your organisation's own addresses** through Microsoft Graph, with an app
registration in your own Entra directory. It sits behind the platform's email relay: an app that
sends with a `from` address your connection covers sends through your mailbox, and everything
else still goes out from the platform's own address.

::: warning Not yet verified against a live tenant
The connector is checked against a stand-in for Entra's token endpoint and Graph: the
certificate is parsed and its signature verified by an independent X.509 implementation, and
every answer Entra or Graph can give is sorted into "refused" or "not yet". What a stand-in
cannot prove is that Microsoft accepts these shapes. Until a real send has gone out, treat the
setup below as written from Microsoft's documentation, not from a run.
:::

## At a glance

| | |
|---|---|
| **Provider** | Microsoft 365 — Microsoft Graph, app-only (client credentials) |
| **Category** | Mail (documents in a Teams channel are planned) |
| **Status** | **Built, not yet live-verified** |
| **Package** | `@substrat-run/connector-microsoft365` (not published yet) |
| **Sends** | through the email relay, for a `from` address the connection covers |

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
either way. Mail cannot be tested without sending, because the app cannot read a mailbox — the
first send is the check.

## Limits

- **Attachments up to about 2.5 MB in total per message.** Graph's `sendMail` takes attachments
  inline; larger files need a draft and an upload session, which needs `Mail.ReadWrite` on the
  mailbox — the permission this setup deliberately leaves out.
- **HTML body only.** A Graph message has one body; the plain-text part is not sent.
- **Custom headers** must start with `X-`; others are left out.

## Rotation and revocation

A generated certificate is valid for a year, and its end is the connection's expiry. Editing the
connection's other fields keeps the same certificate. Disabling or deleting the app under
**Enterprise applications** revokes everything at once.
