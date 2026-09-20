---
'@substrat-run/dashboard': patch
---

A vertical's page now lists the apps still installed on it, and you can move or retire them from there.

Removing a vertical is refused while anything is bound to it, and the refusal only ever gave a number. It now takes you to the vertical's page, where **Bound scopes** lists exactly what was counted — each install with its status, the version it is pinned to and the names it serves. A vertical that backs nothing shows no such section. It lists this team’s installs: if another team has also installed the vertical, the refusal’s count includes theirs, and the refusal message says so rather than implying moving your own is enough.

**Move** comes first. When a package is renamed, new versions land under the new name while the installs stay on the old one, so what is left behind is usually apps that are still in use. Move rebinds them onto another vertical your team owns, data first; the old vertical keeps its copy. If the two have different migrations you have to say you have read both, and the platform's own refusal is shown as it was given. When the page thinks a rename left them behind, it says so and points at pinning `"substrat": { "slug": "…" }` in `package.json` so it cannot happen again.

**Retire** is the other way out, for installs that are finished. It releases the names, archives the app and wipes its storage, with a backup taken first — and it does nothing until you type how many you are retiring. That count is checked on the server, not only by the button. A snapshot copy is deleted outright, and a run stops at the first install that cannot be retired rather than taking the rest offline.

Both are open to anyone who can manage apps on the team, and act only on the team's own installs.
