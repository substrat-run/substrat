---
'@substrat-run/console': patch
'@substrat-run/ui': patch
---

The console survives a narrow viewport, and a tenant-owned vertical's deep link resolves.

Two defects, found together: a link to `/verticals/<tenant>/<name>` opened the verticals
**list**, and on a small screen the version row's Vouch button — the one action that
unblocks listing a privately-pushed vertical (#869) — could not be reached at all.

**The deep link.** A tenant-owned vertical's slug is `<tenantSlug>/<name>` (#417), so the
identifier carries a slash of its own. `readNav` read only the segment after the view, so
`/verticals/acme/crm` resolved to the vertical `acme`, matched nothing, and the view fell
back to the list with no error — the failure looked like the link had simply been ignored.
The API layer had encoded the slug correctly all along; only the browser URL dropped it.
Parsing now takes everything after the view (decoding per segment, so the `%2F` form lands
on the same vertical), and the pair moves to `lib/nav.ts` as pure functions of the URL —
testable without a DOM, which is what `test/nav.test.ts` now does.

**The narrow viewport.** The shell had no responsive layout: the sidebar is a fixed 232px
flex child, so at 390px it kept its full width and squeezed the content beside it to *76px*
of usable card, while `Card` clips (`overflow: hidden`, for its rounded corners). The
trailing buttons were not merely cramped — nothing could scroll to them. Four changes, and
the measured content column goes 76px → 332px with no horizontal page scroll:

- **The sidebar becomes a drawer below 900px** (`useMediaQuery`, new in `@substrat-run/ui`).
  A hamburger in the topbar opens it, a scrim or a nav selection closes it, and `visibility`
  rides the transform so a closed drawer is out of the tab order rather than off-screen and
  still focusable. Not a phone width: the squeeze starts long before the viewport is a phone.
- **`Table` scrolls itself.** Every cell is `nowrap` (a wrapped id or timestamp is
  unreadable), so any table past a few columns is wider than a narrow card. Its own
  `overflow-x: auto` wrapper scrolls instead of the page.
- **`Card` header actions wrap.** The row wraps, and the action group can shrink so a
  grouped set of buttons wraps within itself instead of running past the clip.
- **`SideNav` never shrinks** (`flexShrink: 0`) and scrolls vertically — a nav rendered at a
  partial width is broken chrome that also steals the room the content needed.

`Card`, `Table` and `SideNav` are shared with the dashboard, which gains the same behaviour;
desktop rendering is unchanged.
