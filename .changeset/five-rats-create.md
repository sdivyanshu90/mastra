---
'@mastra/fastembed': patch
---

Fixed empty embeddings when tokenizer metadata omits its maximum length by preserving the requested or default token limit.
