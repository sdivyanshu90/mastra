---
'@mastra/loggers': patch
---

Fixed HTTP log transport retries to serialize each batch once and report serialization failures without retry delays.
