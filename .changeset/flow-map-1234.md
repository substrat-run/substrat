---
'@substrat-run/control-plane-api': minor
---

The flow map: an app's Model tab now draws the whole wired app, not just its entities.

Top to bottom: what starts work (the request path, and each declared schedule with its cadence), the modules that do it, the events they carry, and the providers and hosts they are permitted to reach. The arrows are declarations — which module emits a type, which one handles it — so a path that exists and has never run is drawn rather than missing. That is the inversion worth having: a map inferred from traffic can only show what has happened, and the interesting thing is usually what has not.

Event nodes carry what the app has actually recorded, so the map is read at a glance: a number, or a dashed outline meaning declared and never yet seen. Connections are coloured by whether they are usable, keeping a lapsed credential apart from one that was never created — different fixes.

Four things the map declines to draw, because nothing it reads can support them. There is no operation band: a push declares which *module* emits a type, never which operation inside it, so the map does not invent one. For the same reason the request path is drawn unattached — which module answers a request is an operation-level fact, and an arrow to every module would say requests reach them all, which is untrue of a module that only handles events or only runs on a schedule. Nothing links a provider or an outbound host to a particular module, because those are declared by the app as a whole — membership of the band is the whole fact. And where an app has recorded more kinds of event than can be counted in one pass, the uncounted ones say "not counted" rather than showing a zero that would read as silence.

Where an app declares more than the platform carries with a version, the map says so: whole nodes are then missing, and unlike a missing count a missing node leaves nothing on screen to notice.

Every event node is a link into the event explorer, already grouped on that type — the picture is a way into the data, not a picture of it. And the whole map has a text equivalent for screen readers: every node with its counts, its silence and what it reaches, carrying the same links, because an SVG announced only by its heading is a diagram nobody can read.

The map is a projection and stays one: nothing on it can be moved, edited or saved.
