---
'@substrat-run/control-plane-api': minor
---

The flow map: an app's Model tab now draws the whole wired app, not just its entities.

Top to bottom: what starts work (the request path, and each declared schedule with its cadence), the modules that do it, the events they carry, and the providers and hosts they are permitted to reach. The arrows are declarations — which module emits a type, which one handles it — so a path that exists and has never run is drawn rather than missing. That is the inversion worth having: a map inferred from traffic can only show what has happened, and the interesting thing is usually what has not.

Event nodes carry what the app has actually recorded, so the map is read at a glance: a number, or a dashed outline meaning declared and never yet seen. Connections are coloured by whether they are usable, keeping a lapsed credential apart from one that was never created — different fixes.

Three things the map declines to draw, because nothing it reads can support them. There is no operation band: a push declares which *module* emits a type, never which operation inside it, so the map does not invent one. Nothing links a provider or an outbound host to a particular module, because those are declared by the app as a whole — membership of the band is the whole fact. And where an app has recorded more kinds of event than can be counted in one pass, the uncounted ones say "not counted" rather than showing a zero that would read as silence.

The map is a projection and stays one: nothing on it can be moved, edited or saved.
