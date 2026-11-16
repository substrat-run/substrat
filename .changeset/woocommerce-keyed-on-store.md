---
'@substrat-run/connector-woocommerce': patch
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

A WooCommerce key for another store no longer replaces the store an app is connected to. The platform now tells WooCommerce connections apart by the store each key reads, named by the address the store gives itself, so a key for the same store replaces the old one and keeps the sync where it was, and a key for another store becomes a second connection, listed on its own in the dashboard. A connection made before this holds no store; a key for another store is refused there until it is disconnected.
