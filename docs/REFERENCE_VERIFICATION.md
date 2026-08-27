# Reference exact verification

Reference images must be **counted and hashed**, not guessed from “at least one thumbnail”.

```
request images
→ freeze exact bytes in MediaStore
→ asset_id + stable URL + sha256 + mime + width + height + byte_size
→ attach
→ attached_count == requested_count
→ Generate
→ result sha256 ∉ reference_hashes
```

## Rules

- 1 / 2 / 4 / 6 refs (provider max) are first-class. A single-thumbnail probe is not enough.
- If the page loaded fewer cards than requested: `REFERENCE_ATTACH_INCOMPLETE`. Generate is not clicked.
- If a candidate result’s sha256 equals any reference: `RESULT_IS_REFERENCE_IMAGE`. Not a 200.
- Byte-length equality is a leftover filter only. Isolation is sha256.
- Invalid or over-limit references are HTTP 400; they are never silently dropped.
- Remote references are fetched once from their original URL. Worker attachment
  reads the frozen asset, so the hash and attached bytes cannot drift.

## Worker

`describe_references` / `bind_reference_hashes` run before Generate.

ChatGPT: `count_chat_refs` after attach.
Gemini: `count_gemini_refs` after attach.
Leonardo: `count_leonardo_refs` after attach.

Live E2E of attach/result isolation: **NOT_EXECUTED**.
