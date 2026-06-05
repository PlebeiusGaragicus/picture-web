---
name: read-book
description: >-
  Load an entire book .txt into context using parallel read tool calls sized to
  Pi's ~50KB result cap. Estimates token count from word count and warns if over
  half of a 260k context window. Use when asked to read, summarize, extract from,
  or adapt a full book or long prose .txt file.
disable-model-invocation: false
---

# Full Book Read

Load a whole book with the fewest tool calls: bash metadata, then **all chunk reads in parallel**.

Use **only `read`** for book text. Bash is for metadata (`wc`, token estimate) only — no `cat`, `sed`, `head`, or `tail` on book content.

## Path rule

Strip backslash escapes from user-supplied paths:

```text
GOOD: /Users/satoshi/Desktop/No Place to Hide - Greenwald, Glenn.txt
BAD:  /Users/satoshi/Desktop/No\\ Place\\ to\\ Hide\\ ...
```

---

## Step 1 — Token estimate and chunk plan

Token estimate:

```bash
wc -w "/path/to/book.txt" | awk '{printf "%.0f tokens (est)\n", $1 * 1.33}'
```

Chunk sizing (lines + bytes in one call):

```bash
wc -lc "/path/to/book.txt" | awk '{b=$2/$1; c=int(48000/b*0.95); if(c<150)c=150; if(c>600)c=600; n=int(($1+c-1)/c); printf "lines=%d bytes=%d chunk_lines=%d chunks=%d avg_bpl=%.1f\n",$1,$2,c,n,b}'
```

From the output, record `chunk_lines` and `chunks` as `CHUNK_LINES` and `NUM_CHUNKS`.

Constants:

```text
CONTEXT_WINDOW = 260000
HALF_CONTEXT   = 130000
```

- If estimated tokens **> 130000**: tell the user **WARNING: book may exceed ~50% of the 260k context window** after all chunk reads load. Continue anyway unless they ask to stop.
- If **≤ 130000**: note the estimate for information only, then continue.

Do **not** call `read` before the parallel batch. Chunk size comes from `wc -lc` only.

---

## Step 2 — Parallel read (one turn)

In a **single assistant turn**, issue one `read` per chunk:

```text
read path="/path/to/book.txt" offset=1                              limit=CHUNK_LINES
read path="/path/to/book.txt" offset=CHUNK_LINES+1                  limit=CHUNK_LINES
read path="/path/to/book.txt" offset=2*CHUNK_LINES+1                limit=CHUNK_LINES
...
read path="/path/to/book.txt" offset=(NUM_CHUNKS-1)*CHUNK_LINES+1   limit=CHUNK_LINES
```

Offsets are **1-based**. Do not read chunks across separate turns when loading the full book.

After results return:

1. If any chunk is **≥ 48000 chars**, lower `CHUNK_LINES`, recompute offsets, and re-issue **all** reads in one turn.
2. Spot-check that chunk boundaries connect (last line of chunk N flows into first line of chunk N+1).
3. Proceed with the user's task using the combined text now in context.

---

## Example

```bash
wc -w "/Users/satoshi/Desktop/No Place to Hide - Greenwald, Glenn.txt" | awk '{printf "%.0f tokens (est)\n", $1 * 1.33}'
wc -lc "/Users/satoshi/Desktop/No Place to Hide - Greenwald, Glenn.txt" | awk '{b=$2/$1; c=int(48000/b*0.95); if(c<150)c=150; if(c>600)c=600; n=int(($1+c-1)/c); printf "lines=%d bytes=%d chunk_lines=%d chunks=%d avg_bpl=%.1f\n",$1,$2,c,n,b}'
```

→ e.g. `chunk_lines=330`, `chunks=9` → nine parallel `read` calls at offsets 1, 331, 661, 991, 1321, 1651, 1981, 2311, 2641.

---

## Forbidden

- A probe or preview `read` before the parallel batch
- Sequential one-chunk-per-turn when loading the full book
- `cat` / `sed` / `head` / `tail` on book content
- Escaped paths in `read` arguments
- Declaring full coverage without issuing all `NUM_CHUNKS` reads

# User Request

Please read the book or follow instructions, if provided, by the user - else, ask for a book file to process.

**User:** `@$`
