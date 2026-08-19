---
id: D-14
date: 2026-07-12
layer: plan
title: "Every kernel contract ships a Cloudflare adapter and a pure SQLite adapter"
status: accepted
aliases: []
tracking: []
---
# D-14 — Every kernel contract ships a Cloudflare adapter and a pure SQLite adapter

Every kernel contract ships a Cloudflare adapter **and** a pure SQLite adapter; contract tests pass on both

## Why

Auth-platform pattern; makes escrow/self-host real, hedges vendor risk, enables local dev/CI (§5.7)
