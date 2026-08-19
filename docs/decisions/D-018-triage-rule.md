---
id: D-18
date: 2026-07-12
layer: plan
title: "Triage rule"
status: accepted
aliases: []
tracking: []
---
# D-18 — Triage rule

Triage rule: kernel-owned (enforcement inputs + contracts) / adapter (infra the kernel consumes: billing rails, model providers, KMS, telemetry via OTel, notification transports, search backends) / connector (capabilities tenants use, in the hub)

## Why

One test decides every future "should X be swappable" debate; event spine, tenancy/permission model, entitlements, manifest are never adapters (§5.7)
