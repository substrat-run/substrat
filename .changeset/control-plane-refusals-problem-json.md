---
'@substrat-run/control-plane-api': patch
---

Every refusal the control-plane API answers is now an RFC 9457 problem document served as `application/problem+json`, including the ones a route decides itself (an unknown scope, a forbidden credential, a capability this plane is not configured with), not only the ones raised by a throw. Statuses and the `error` sentence are unchanged, and so is every other member a refusal carried, so existing clients read the same answer; they also get `type`, `title`, `status`, `detail` and, where the failure has one, a `code`. A request no route matches answers a `not_found` problem instead of a plain-text 404. The API logs `control-plane.non-problem-refusal` (method, route pattern, status) if anything still answers a failure in another shape.
