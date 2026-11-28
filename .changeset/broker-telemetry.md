---
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/contract-tests': minor
---

The delivery broker reports what it does (#3474): a data point at each handoff, receipt, delivery and retry, carrying no message content, and its queue depth, oldest message's age, paused receivers and dead-letter count whenever they change. `BrokerTelemetry` is the shared reporter; the Durable Object broker writes to an Analytics Engine dataset bound as `SUBSTRAT_BROKER_TELEMETRY` and answers `state()`, the pure host takes a `telemetry` sink, and `deliveryBrokerTelemetryContractSuite` holds both. Nothing is written unless the dataset or sink is given.
