// The node suite sees the LIKE/GLOB pattern limit a Durable Object enforces (50 bytes), so a
// pattern that passes here passes deployed too — see apps/docs/concepts/scope-host.md, "SQL
// limits on ctx.sql". Side-effect import: patches better-sqlite3's Database.prototype.
import '@substrat-run/adapter-sqlite/testing';
