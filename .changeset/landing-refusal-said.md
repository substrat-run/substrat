---
'@substrat-run/kernel': minor
'@substrat-run/dashboard': patch
'@substrat-run/control-plane': patch
---

kernel: `landingRefusalSaid` turns an app's own refusal of a connector's landing call into a line its tenant may read, and withholds everything else (#3235). control-plane: the WooCommerce sweep hands the pass that line for a binding its app refused. dashboard: a connection's failed sweep is written out under its run strip, not only in the tick's tooltip.
