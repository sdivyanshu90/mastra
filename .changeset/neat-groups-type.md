---
'@mastra/loggers': patch
---

Fixed Upstash log transport to retain batches rejected by Redis and report trimming failures without resending stored logs.
