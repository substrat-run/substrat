---
'@substrat-run/demo-auth-server': minor
---

Sign in with Supabase. A Supabase project now runs a standards-compliant OAuth 2.1 /
OIDC server, so the issuer's Custom (OIDC) door already admitted one — but only for an
operator who knew the one thing nobody can guess: a project's issuer is the project URL
with `/auth/v1` on the end, and the project URL alone serves no discovery document.
Paste the URL you have and discovery returns a 404 that names nothing. Supabase is
therefore a named entry in the sign-in providers catalogue rather than one more thing to
type into the open door: the catalogue supplies the name, the button, the redirect URI to
register and a field hint that says where the suffix comes from, and the operator supplies
a project and a credential. Underneath it is the same generic row as any custom provider —
discovery resolved once at save time, endpoints stored, the same callback path — so
nothing about a Supabase sign-in is special at runtime. The precondition on the Supabase
side is stated rather than hidden: the project needs its OAuth 2.1 server turned on,
authorization UI included, which no setting here can stand in for. Catalogue entries are
now of two kinds — providers the library ships built-in, and named generic ones like this —
and a test holds that distinction against the library's own list, so a provider Better
Auth adds later cannot be silently shadowed by ours.
