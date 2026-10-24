---
"@open-rgs/core": patch
---

Preserve an open round when a sessionClosed autoclose is held or fails. Evict only after confirmed settlement under the session lock, so the round remains available for reconciliation.
