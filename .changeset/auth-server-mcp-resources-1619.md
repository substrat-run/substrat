---
'@substrat-run/demo-auth-server': minor
---

The auth server mints tokens for the MCP endpoints of the verticals that sign in with it, so an MCP client reaches a vertical with nothing configured by hand.

An MCP client asks for a token for the endpoint it discovered, as an RFC 8707 `resource`. The auth server refused every such request with `invalid_target … is not configured`, before any login page, because nothing ever registered a vertical's endpoint as a resource. The platform now does: the dashboard delivers `substrat:resources:<app scope>` through `/internal/configure`, and the auth server turns it into exactly that app's set of registered resources. A repeat delivery writes nothing. An empty one un-registers, and from then on the resource can be neither minted nor refreshed. A resource an operator registered is never changed or removed by it. A delivery is one transaction: a malformed one is refused whole, and a write that fails halfway rolls back everything the delivery did.

Two policy changes come with it. Any client of the issuer may now request a token for any registered resource (`enforcePerClientResources: false`). Every MCP client registers itself and none is ever linked to a resource, so leaving the per-client check on would refuse all of them. What protects a resource is the user's own sign-in and consent, the resource server's `aud` check, and the resource server's own permissions. And managing resources through the plugin's server-side admin API now needs an administrator, as managing clients already did. Left unset, it accepted any signed-in session.

Discovery now also carries `resource_parameter_supported: true`. It is not an IANA-registered metadata name, so a client that does not know it ignores it.
