# Shared To-Do Lists — Concept

## 1. What we're building & who uses it
A shared to-do app. You own lists, keep most private, and invite specific people to some of them. Users: list owners and the people they invite (by email; nobody self-signs-up).

## 2. The thing that moves
A list holds items; an item is open or done. Ticking can be undone. No staged lifecycle, so no engine or locked-down transitions.

## 3. Already there vs. yours
- **Free from the platform:** tenancy, permissions (including grants narrowed to one list), audit events, migrations, sending email from an operation (`requestEmail`).
- **Yours:** lists, items, the share table, people names, the web UI.
- **Not used:** workorder, booking, invoicing, protocol engines; no schedules.

## 4. Who can do what
- **Owner:** creates, renames, deletes own lists; adds, edits, ticks, deletes items; shares a list; sees who it is shared with and who is invited; removes a share or withdraws an invitation.
- **Invited person on a shared list:** sees the list; adds items; ticks/unticks items; edits or deletes their own items. Cannot delete the owner's items, cannot delete the list, cannot share it onward, cannot see the share list.
- **Everyone else:** sees nothing. Private lists are visible only to the owner.
- **Other tenants:** nothing visible across tenants.
- **Money:** none.

## 5. Money & sign-off
Neither.

## 6. Cast, roles, tenancy
Two tenants seeded; the second exists to be attacked.
- **Tenant A:** Markus (owner), Alice (shared one list), Bob (no share), Dana (invited, has not joined).
- **Tenant B:** one user with their own lists.

## 7. Data we'll store
- `lists`: name, owner, created date.
- `items`: list, text, done flag, who ticked it, created by, created date.
- `list_shares`: list, person, who shared it (grants can't be listed).
- `list_invites`: list, address, who invited them, until that person joins.
- `people`: display name per user (source for names shown in the UI).

## 8. Screens
One web UI: "My lists", "Shared with me", list detail with items, and a share dialog for owners.

## 9. Test scenario
- Owner creates a list, adds items, shares with Alice.
- Owner invites Dana, who has not joined. The email goes out, Dana is refused the list, and it is there after signing in.
- Alice adds an item and ticks one.
- Alice is denied deleting the list and sharing it onward.
- Bob cannot see the list.
- Tenant B sees nothing of tenant A.

## 10. Assumptions
- Lists are private until shared.
- The owner shares by email. If that person has joined, the list is shared at once. If not, they get an invitation email, and the list is shared when they sign in with that address.
- Joining happens at sign-in, with the verified address. Nobody types an address to join.
- Shared people can add and tick; they can edit/delete only their own items, not the owner's.
- Sharing is per list, never across all lists.
- Items have only text and a done flag; no notes, priorities, or order beyond creation time.
- One shared done flag per item.
- Two tenants are seeded.
- Roles are named for the persona (e.g. `list-owner`, `list-collaborator`).

## 11. Out of scope
Due dates, reminders, recurring tasks, real-time collaboration, comments, self-signup.
