---
'@mastra/loggers': patch
---

Fixed HTTP and Upstash log transports keeping idle processes alive after their buffers have drained.
