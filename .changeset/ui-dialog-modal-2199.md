---
'@substrat-run/ui': patch
---

`Dialog` is now a modal dialog for assistive technology and the keyboard (#2199): it carries `role="dialog"` and `aria-modal`, is named by its title and described by its description, closes on Escape (not while `busy`, and not when a control inside already consumed the key), moves focus in when it opens, keeps Tab and Shift+Tab inside, and hands focus back to the control that opened it. No prop changed.
