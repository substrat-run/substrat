---
'@substrat-run/ui': patch
'@substrat-run/console': patch
---

A console action says it is running. Every mutation on a vertical's page — Admit,
Reject, Vouch, Promote, List/Unlist, the two capability grants, retire, delete — is
an HTTP round trip followed by a full re-walk of the page's data, a second or more
during which the console rendered nothing at all: the button sat there looking
un-pressed until a toast appeared. So the pressed button now carries a spinner and
stops accepting clicks, and every other action on the page goes inert until the
work and the re-walk have both landed. A confirm dialog does the same, and while its
confirm is in flight Cancel and the click-outside backdrop stop answering — a dialog
dismissed mid-request leaves an operator with no idea whether the thing happened.

The mechanism is in the shared design system rather than the page: `Button` takes
`loading` (spinner in the icon slot, implies `disabled`, sets `aria-busy`, label
unchanged so the row does not move), `Dialog` takes `busy`, and there is a `Spinner`
primitive behind both. The two bulk dialogs drop their hand-rolled "Moving…" /
"Retiring…" relabels in favour of it.

One refusal moves earlier while the dialogs are being touched: promote's confirm is
disabled until the acknowledgements it demands are ticked, instead of accepting the
click and answering with a refusal toast. The dialog already names what is unticked.
