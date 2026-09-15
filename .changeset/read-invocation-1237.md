---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
---

Everything one request did can now be read together, and counted by request.

Two reads already followed cause: backwards from an event to what set it off, and forwards to what it set off in turn. Both follow the chain, so both miss a sibling — and a sibling is most of what someone means by "what did this request do". An operation that raises two unrelated events leaves two records with no link between them; from either one, the other is invisible.

Reading by request returns them together, oldest first, including anything the request's handlers raised while it finished up. It says when it is showing only part of a large one, rather than presenting a fragment as the whole.

Requests also became something you can group by. The platform's set of ways to slice events — by type, by who, by operation, by version — could not include the request, because until recently there was nothing to group on. Now "which requests did the most" is a question with an answer.
