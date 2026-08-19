---
id: K-8
date: 2026-07-12
layer: kernel
title: "Verticals never hold raw DO namespace bindings"
status: accepted
aliases: []
tracking: []
---
# K-8 — Verticals never hold raw DO namespace bindings

Verticals never hold raw DO namespace bindings; one service binding to the kernel entrypoint, which authenticates and mints stubs

## Why

Stub minting with trusted principal context is the enforcement point; DO ACL stays defense in depth
