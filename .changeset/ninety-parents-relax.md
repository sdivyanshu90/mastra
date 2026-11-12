---
'@mastra/rag': patch
---

Fixed JSON chunking to reject maxSize below 21 instead of entering a non-progressing string split.
