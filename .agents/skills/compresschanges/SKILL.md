---
name: compresschanges
description: "Run only when explicitly invoked. Klawde journal compaction: summarize CHANGES.md entries older than 30 days while preserving decisions and scope changes."
---

# /compresschanges: Compact CHANGES.md History

Run this when CHANGES.md has grown too large. Compresses the history while preserving a high-level summary of everything to date.

## Steps

1. Back up the current file: `cp CHANGES.md "CHANGES.md.bak.$(date +%Y%m%d-%H%M%S)"`. Record the line count from `wc -l < CHANGES.md`.

2. Read `CHANGES.md` completely.

3. Identify all entries older than 30 days from today's date.

4. Group those older entries by month (YYYY-MM). For each month, write one summary line per major theme or area of work. Use the format:

   `YYYY-MM-DD [note] Summary: <concise description of that month's key changes>`

   Use the last day of the month as the date. Preserve any entry of type `[decision]` or `[scope]` verbatim (do not summarize those away). Existing `[note] Summary:` lines from earlier compressions may be merged into the month's summary, never expanded.

5. Construct the full new file content (header, format hint, summary lines, preserved verbatim entries, last-30-days entries) and write it in a single Write call. Do not use incremental Edits.

6. Ensure the file header and format hint line remain intact. Record the new line count from `wc -l < CHANGES.md`.

7. Output exactly this format, using the recorded line counts, then stop:

```
CHANGES.md compressed.
Lines before: [count]
Lines after: [count]
Preserved verbatim: [count] (decisions/scope changes)
```

Do not modify BRIEFING.md. Do not alter any entries from the last 30 days.
