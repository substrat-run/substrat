---
'@substrat-run/elements': minor
---

`<sub-entity-table>` and `<sub-user-menu>` take a `labels` property (`EntityTableLabels`, `UserMenuLabels`) covering every word they show or announce, resolved as the element's own labels, then the words registered for its `lang` in Web Awesome's translation registry (`registerEntityTableLabels`, `registerUserMenuLabels`), then English. Each passes its language to the Web Awesome components it draws, and the table formats numbers and dates in it. The table reuses Web Awesome's own words where it has them, so its "Reset to default" now reads "Reset columns" and a column move is announced as "Name moved to position 2 of 5". A `lang` property set on any Substrat element is now honoured, not only the attribute.
