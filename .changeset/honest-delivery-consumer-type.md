---
"@substrat-run/contracts": minor
---

Type delivery and dead-letter consumers as ModuleId | ExecutorConsumerId instead of branding executor keys as module IDs. Runtime accepted values are unchanged. Export the executorConsumerId schema and parseExecutorConsumer helper so callers can distinguish executor keys before using a consumer as a module ID.
