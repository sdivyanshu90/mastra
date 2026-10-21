---
'@mastra/fastembed': patch
---

Fixed sentence embeddings for all-MiniLM-L6-v2 and multilingual-e5-large to use mean pooling over tokens selected by the attention mask.
