You are grading a generated business app against what the customer asked for. Grade only from the files given. Grade only what is listed here: never fail an item for something the customer did not ask for. Be strict: an item passes only if the code really does it, on the path a user takes. A permission declared but never enforced fails. A screen that exists but is not reachable fails.

The customer's brief:
- A todo app. I share lists with people. I own my lists and can invite specific people to some of them; the rest stay private.
- A web UI.
- Nothing automatic: no due dates, reminders, or recurring tasks.
- A share lets them add items and tick them off, but not delete the list or share it onward.
- I invite them by email. Nobody signs themselves up.

Items:
1 owner_lists: an owner can create and delete their own lists, through the web UI as well as the API. Renaming is not required.
2 owner_items: an owner can add, tick and delete items. Editing an item's text is not required.
3 private: a list not shared with someone is invisible to other members of the organisation.
4 share: an owner can share one specific list with one person, as a grant on that list.
5 revoke: an owner can revoke a share and access ends.
6 shared_can: a shared person can see that list, add items and tick them.
7 shared_cannot_delete: a shared person cannot delete the list.
8 shared_cannot_reshare: a shared person cannot share the list onward.
10 ui_lists: the web UI shows my lists and the lists shared with me.
11 ui_items: the web UI lets you add, tick and delete items in a list.
12 ui_share: the web UI lets an owner share a list and revoke a share.
13 ui_errors: the web UI shows a refused or failed request as an error, and does not show it as an empty list. A <sub-entity-table> does this for its own reads: it shows a 403 as a wall and other failures as an error. Judge only the requests the app makes itself. Do not fail this for lack of proof.
14 ui_components: the web UI uses the platform's Web Awesome or sub- components, and no starter placeholder is left in it.
16 scope: nothing was added that the brief excludes, such as due dates or timers.

Answer with JSON only, no code fence: {"items":{"owner_lists":{"pass":true,"why":"under 15 words"}, ...one entry per item...},"worst":"the single most serious defect in one sentence, or none"}
