# Image result correlation

A result image must belong to **this request**.

```
Generate click
→ GenerationBoundary (container ids, srcs, hashes)
→ GeminiResultLocator / LeonardoResultLocator
→ ResultCandidate
→ VERIFIED | HIGH | MEDIUM | LOW | REJECT
```

Production returns only **VERIFIED** and **HIGH**.

Page-wide `img` scan is last-resort fallback and still goes through the scorer. History, reference thumbnails, avatars, and logos are REJECT.

Live E2E of this rule: **NOT_EXECUTED**. Unit: 100 synthetic DOM permutations.
