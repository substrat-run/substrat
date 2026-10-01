---
'@substrat-run/cli': minor
---

Include ordered SQL migrations, their owning modules and versions, and Durable Object classes in the migration digest sent with each push. SQL edits and derived search or list indexes now trigger the migration acknowledgement on promotion, including when the SQL list is too large to carry in the manifest. On an older kernel that cannot derive index SQL, changes to the index declarations still move the digest.

The digest format changes for every vertical. The first push with this CLI will therefore require a one-time migration acknowledgement on promotion even if its SQL has not changed.
