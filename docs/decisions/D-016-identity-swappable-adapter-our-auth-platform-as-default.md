---
id: D-16
date: 2026-07-12
layer: plan
title: "Identity = swappable adapter (our auth platform as default)"
status: accepted
aliases: []
tracking: []
---
# D-16 — Identity = swappable adapter (our auth platform as default)

Identity = swappable adapter (our auth platform as default); tenancy tree, directory, and permission **model** are kernel-owned, never delegated; permission **evaluation** is an adapter (built-in default, OpenFGA-swappable)

## Why

Enforcement inputs must be kernel-owned or "swappable auth" is fiction; auth providers authenticate, they don't own org structure (§6)
