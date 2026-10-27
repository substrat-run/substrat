---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/cli': minor
'@substrat-run/router': minor
'@substrat-run/control-plane': minor
'@substrat-run/dashboard': minor
---

Vertical-defined connectors (D-64, proposed). A vertical can define its own connector, named `<namespace>.<name>`, and ship it with `substrat push`. The platform keeps the credential, the bindings, the connector's state and the sweep schedule, and runs the provider code in the vertical's own worker through the router, so the vertical's declared `outbound` hosts bound it. vertical-host: `defineConnectors`, `declareConnectorEvents` and `runConnectorCall` under `@substrat-run/vertical-host/connectors`; `mountPlatformSurface({ connectors })` serves `/internal/connector-probe` and `/internal/connector-call`. kernel: `ConnectionContext`, `ScopedConnectionContext` and `ConnectorRefusal`, the capability a connector is handed instead of `HostAdmin`; the connector and landing passes take `sweeperFor` / `binderFor` fallbacks. contracts: `connectionProvider` accepts one dot; the declaration, call and binding schemas; `deployManifest.connectors`, `permissionRegistry.connectors` and `pushedConnectorProblems`; the wire gate admits the router on the two connector paths. control-plane-api: the vertical connector sweeper, binder, inspector and dispatch handler, and the push routes refuse a connector grant the registry does not declare or reserves. cli: `substrat.connectors` is read, validated and pushed, and a connector's standing grants join the permission registry and its digest. router: the `ConnectorCalls` entrypoint. control-plane: the `CONNECTOR_CALLS` binding and the fallbacks at every connector lookup. dashboard: an app offers the connectors its vertical declares.
