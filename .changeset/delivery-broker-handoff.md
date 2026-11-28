---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

The delivery broker's contract (K-74): `DeliveryBroker`, `DeliveryReceiver` and the shared `BrokerStore`, plus the handoff of a scope's emitted events and raised intents after commit.
An in-process `InProcessDeliveryBroker` and the `deliveryBroker` host option on the pure host, with `retryHandoffs`.
`defineDeliveryBrokerDO`, and a scope that hands off to it when its script binds `SUBSTRAT_DELIVERY_BROKER`, retrying from its alarm; nothing is handed off without the binding.
`deliveryBrokerContractSuite`, run by both adapters.
