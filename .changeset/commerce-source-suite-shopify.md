---
'@substrat-run/contract-tests': minor
'@substrat-run/contracts': patch
---

contract-tests: `commerceSourceSuite`, the behaviour every commerce-source connector shares, now exported; a product sold without variants is checked as one untitled variant, whatever id the store gives it.
contracts: the commerce-source vocabulary's notes name Shopify beside WooCommerce, and say a single variant's id is the store's to give.
