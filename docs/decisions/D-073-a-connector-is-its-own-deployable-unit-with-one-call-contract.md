---
id: D-73
date: 2026-11-18
layer: plan
title: "A connector is its own deployable unit with one call contract, and where it runs is a choice"
status: proposed
aliases: []
amends: ["D-64"]
tracking: ["#2855"]
---

# D-73 — A connector is its own deployable unit with one call contract, and where it runs is a choice

> Proposed, not accepted: the direction is agreed with the owner as a direction, and phase 1 is a
> pilot that measures the hop it adds. The design is [connector-scripts.md](../rfc/connector-scripts.md).
> Nothing outside the test environment relies on it, and its flag is off everywhere.

**Every connector is its own deployable unit, called through one contract: D-64's
`connectorCallRequest` → `connectorCallResponse`.** A first-party connector may run as its own platform
script in the dispatch namespace, named `substrat-connector-<provider>`, or inside a vertical's worker as
D-64 has it; placement is a registration choice, not a different kind of connector. Connectors stay
stateless: they return state writes, and the control plane applies them, under the scope's lease where a
scope is involved. The platform keeps credential custody: a connector is handed the one credential a call
needs, in the call (or later a per-connector secret binding), never the control plane's storage. Its
outbound calls leave only through the egress hop, to the hosts its registration declares. The contract
evolves additively, as an engine surface does.

Phase 1 runs one connector, Bolagsverket, this way, in TEST only, behind `REMOTE_CONNECTORS`: its probes
go to its script through the router's `ConnectorCalls.callScript`, and with the flag off they run
in-process exactly as before. The `substrat-connector-` prefix is reserved like `substrat-store-`, so no
vertical deploys under a connector's name.

## Why

A first-party connector runs in the control plane with a `HostAdmin` that reaches every tenant, and every
change to one is a control-plane deploy. Store drivers already left the control plane for scripts of their
own (D-63, D-70), and vertical-defined connectors run in the vertical's worker handed one connection per
call (D-64). The contract D-64 built for that call already carries what a first-party connector needs —
the credential per call, the uses and state writes back — so a second contract is not needed, and one
contract is what makes placement a choice later.

It is proposed rather than decided because the price is a hop per call, which nobody has measured on the
platform. Phase 1 exists to measure it: the hop probe logs in-process and script latency side by side
for each call. A release pin or approval for connector scripts (D-63, D-65), the scoped roles (`bind`,
`sweep`, `dispatch`) and a signed door on the script are later phases, and the decision is not relied on
until they are designed.
