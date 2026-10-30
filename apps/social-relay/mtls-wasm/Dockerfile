# The one toolchain the mTLS module is built with (tools/mtls-wasm-emit.mjs). Pinned by digest
# and run as linux/amd64 on every host, so a laptop and CI produce the same bytes.
FROM rust:1.91-slim-bookworm@sha256:8514999d4786ef12efe89239e86b3d0a021b94b9d35108c8efe6c79ca7dc1a65
# ring compiles C for the wasm target; Debian's clang carries the WebAssembly backend. Installed
# from the dated snapshot the base image names in its own sources, not the moving archive, so a
# Debian update cannot change the bytes a rebuild of unchanged source produces.
RUN sed -i 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20251208T000000Z|; s|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20251208T000000Z|' /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends clang llvm \
 && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version 0.2.129 --locked \
 && rm -rf /usr/local/cargo/registry
