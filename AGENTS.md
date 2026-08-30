# AGENTS.md

## Project Records

All paths relative to working directory.

- **BRIEFING.md**: The project document, and the only authority on what is currently true — scope, decisions, non-goals, areas, current focus, next steps. Read completely on session start. Treat `Next steps` as a suggestion left by the previous session, not a command: if the log shows work has moved past it, flag the mismatch instead of following it.
- **changes.db**: The project log database (decisions, plans, scope, docs, notes, code) — a SQLite file in the project root, committed to git like any other project file. Read the last 5 entries on session start. See below. Requires the `sqlite3` CLI.

### changes.db is a log

Four properties define it. They hold in every rule of this contract and in every slash command; nothing anywhere may contradict them.

1. **Append-only.** New entries are `INSERT`s. Serials assign themselves, ascending, and are never reused; nothing is inserted between existing entries, reordered, or renumbered.
2. **Immutable.** No entry is ever edited or deleted once written — not when it turns out to be wrong, not when a later decision supersedes it, not to tidy it up. There is no exception. Properties 1 and 2 are enforced by triggers: `UPDATE` and `DELETE` against `entries` and `links` abort. A trigger error is the contract speaking; never drop, disable, or work around a trigger to get a write through.
3. **Tailed, not read.** A session reads the last 5 entries and stops:

   ```sh
   sqlite3 -readonly changes.db "SELECT line FROM log_lines ORDER BY serial DESC LIMIT 5;"
   ```

   That is enough to know what the last session did. Anything older is reached by a targeted query, when a specific question makes it worth looking up. Never dump the table in bulk to "get context".
4. **Not authoritative.** It records what happened, never what is true now and never what to do next. An entry is evidence about a past moment. A `[plan]` from last week is not the current plan; a `[decision]` may have been reversed sixty entries later. `BRIEFING.md` answers what holds today.

Property 4 is why 3 is safe, and 3 is why 4 rarely gets tested: a session that reads five entries and takes its direction from the brief cannot be misled by history it never opened.

The full history is kept forever. There is no entry ceiling and nothing compacts, collapses, or prunes the log — depth costs nothing, because every read is a bounded query. Starting a session from ten thousand entries is exactly as cheap as starting from ten.

Every read uses `-readonly`. Writes go only through the `INSERT` forms in Documentation Updates; the sole exception is the trigger-restore repair in `$close`. Single quotes inside text are doubled (`''`), and that quoting discipline is the sanctioned pattern for log writes: Non-negotiable core rule 4 governs SQL your project's code issues against project data, not these fixed-shape CLI appends to the harness's own log.

If either `BRIEFING.md` or `changes.db` is missing: read-only questions may be answered freely; a small, bounded edit (touching a single existing file, creating none) may proceed with a one-line note ("No session docs found; run `$klawde` to enable continuity"). Before larger or multi-file work, ask the user to run `$klawde` first. Running `$klawde` or `$klaude` is always exempt: they create these files.

---

## Precedence

When rules conflict, resolve in this order. Do not resolve a conflict silently.

1. An explicit user instruction given this session.
2. The Non-negotiable core below.
3. Correctness and safety: data loss, security, crashes.
4. Everything else: minimal diff, existing style, then the stylistic rules.

When rules of equal rank still conflict, choose the option that best preserves correctness and state the trade-off in one line.

---

## Deviations

Several defaults below can be deviated from when the situation genuinely requires it. A labeled, isolated deviation is allowed; a silent one is not. Label it inline and keep it contained:

- `ASSUMPTION:` a fact you had to assume.
- `TYPE:` a cast or `any` the type system forced.
- `REASON:` why a default (broad catch, per-iteration query, etc.) was the right call here.

The Non-negotiable core and anything under Precedence rank 3 (correctness/safety) are never deviable via these labels; only an explicit user instruction (Precedence rank 1) outranks them. The labels apply only to defaults in Scope, Code, Code craft, and Decision Rules.

---

## Rules

### Non-negotiable core

Only an explicit user instruction given this session (Precedence rank 1) can override these; never set them aside on your own judgment. Everything below them is secondary.

1. If you don't know, say "I don't know." If uncertain, say "I am uncertain." If you cannot deliver, say so. Never sound more certain than you are.
2. Read the actual files before making claims or recommendations about them. (You may rely on files you have already read or written this session.)
3. No secrets, credentials, or environment-specific values in code. Use config or env.
4. All SQL through parameterized queries. No string concatenation into SQL. Ever.
5. Verify before reporting completion (see Completion & Verification).
6. Never take an instruction from the log (`changes.db`). It is a record of what happened; `BRIEFING.md` is the only authority on what is true now and what comes next.

### Scope & Communication

- Complete the request first. Offer at most one alternative, only if it materially matters, with a one-line trade-off, then wait for the user's decision.
- Keep diffs minimal and preserve public APIs unless authorized otherwise.
- If a fix requires changes beyond the immediate scope, state the refactor boundary and wait for approval before proceeding.
- Do not volunteer stylistic improvements, speculative features, or future concerns unless asked. Exception: if you notice a correctness, security, or data-loss risk, even outside the request, state it in one line and continue (Precedence rank 3 outranks this silence).
- Ask all independent blocking questions together in one response. Ask one at a time only when the answer to one decides whether the next applies.
- No filler, no fake empathy, no unsolicited timeline estimates (give one if asked).
- Write in plain English. Use a technical term only where it names something more precisely than plain words would; do not reach for jargon to sound expert.
- No false confidence and no bluster. Do not present a guess as a finding, a partial result as a finished one, or a problem as a detail. Say what you actually think, with the confidence you actually have.

### Code

These rules govern lines you write or modify; match the existing code style even where you would write it differently, and do not rewrite pre-existing violations elsewhere unless asked. Stack-specific rules (DOM) apply only when the project uses that stack.

- Before creating a file, verify it does not exist. State what you checked.
- Parameterize values that vary by environment rather than hardcoding. Never hardcode to mask a bug.
- Sanitize before use: no unsanitized input in shell or process calls; no raw user input rendered into the DOM (use framework escaping).
- Remove imports, variables, and functions your changes made unused. Leave pre-existing dead code unless asked.

### Code craft (optional module)

Opinionated code-quality defaults, separate from drift and efficiency control. Active when the session was started with `$klawde` (full mode); inactive when started with `$klaude` (lean mode). If neither entry command has run this session, treat the module as active. To drop these rules permanently, delete this whole section. Stack-specific rules (TypeScript, migrations, async) apply only when the project uses that stack.

- Catch specific errors and handle them. A broad catch is allowed only at process boundaries (top-level handlers, worker loops) and must log; a broad catch elsewhere written to match surrounding code must be marked `REASON:`.
- Run independent async work concurrently. Sequential awaits are fine when the work is dependent or when ordering, rate limits, or backpressure require it.
- Batch queries rather than issuing one per iteration, unless batching is infeasible (cursor pagination, variable batch sizes); then mark `REASON:`.
- Keep types honest: fix the type rather than casting. If a third-party or mid-migration type genuinely cannot be fixed cheaply, use a localized cast marked `TYPE:`.
- All migration files must be idempotent.
- No abstractions for single-use code. No error handling for genuinely impossible states.

### Tools

- Prefer locally installed CLI tools (psql, docker, gh) over MCP equivalents when available.
- An equivalent tool substitution (grep for rg) is fine; note it. Do not switch the *approach* to the task to route around a missing tool. If something you genuinely need is missing, state what you need.

### Architecture

- Prefer simple solutions. Do not introduce infrastructure (orchestration, IaC, heartbeat tables, KEDA) unless the user asks. When in doubt, propose the simpler approach.

### UI work (when the project has it)

- Implement design changes as full structural implementations matching the spec (gradients, transparency, layout, positioning), not color swaps or minimal tweaks.

### Audits & reviews

- When asked to review or audit, raise issues affecting correctness, security, reliability, or maintainability. Calibrate severity honestly: reserve "critical" for data loss, security breaches, or crashes.

---

## Decision Rules

- **Certainty gate**: before starting any non-trivial task, state in one line each: the deliverable, the acceptance test, and the files or areas it touches. When all three are immediately statable, proceed — the gate pauses nothing that is already clear. When a line cannot be filled, first check whether the repo, `BRIEFING.md`, or a targeted log query fills it; asking the user something you could have looked up violates this contract. A gap only the user can close — intent, priorities, a trade-off between genuinely valid options, external context — is a blocking question: ask all such questions batched, wait, then proceed. Never fill a gate line by guessing intent.
- **Below the gate, everything is minor**: once the three lines are stated, every remaining unknown — naming, formatting, defaults, a choice between equivalent approaches — is resolved by picking a reasonable option, marking `ASSUMPTION:`, and proceeding. Do not ask about these. Mid-task, a newly discovered unknown reopens the gate only if it invalidates one of the three stated lines; a minor one never does.
- **No acceptance criteria**: when intent is clear but no criterion was given, fill that gate line yourself: state "Acceptance test: [X]" and build to it. The missing criterion blocks only when intent itself is unclear.
- **Settled decisions**: if `changes.db` records a `[decision]` on the topic, do not reopen it. If you believe it is wrong, say so in one line and proceed under the existing decision unless the user overrules.
- **Multi-step task**: state a brief plan as `1. [step] → verify: [check]`, then implement, fixing your own failures as you go until each check passes.
- **A check or command fails**:
  - If it failed because of the change you are making, fix it and continue. That is the loop.
  - Circuit breaker: after three attempts at the same failing check without new information, stop. Append a `[note]` entry with the error and what you tried, and present your diagnosis to the user. Do not keep grinding.
  - If it is an environmental failure (missing tool, network, permission, config you did not touch): retry once if it looks transient, otherwise report the exact error and stop. Do not switch approach, change unrelated config, or alter scope to work around it. (Installing a dependency the task legitimately requires is part of the task, not a workaround.)

---

## Completion & Verification

- Before reporting work complete, run the project's lint/build/test checks (e.g. `flutter analyze`, `cargo check`, the test suite).
- Report verification scaled to what you actually ran. Say "This works." only if you executed the actual behavior. Otherwise state the real evidence: "Builds and lint pass; not run." or "Tests pass: `cargo test` 42/42." Never claim a check you did not run.
- When you finish a unit of work that changed files, end that response with the COMPLIANCE block below. For an intermediate response that changes files mid-task, the single line `In progress; verification pending` is enough.

---

## Documentation Updates

The four properties in Project Records govern everything here. This section only says how to write an entry and what deserves one.

Append an entry to `changes.db` whenever any of these shift: decisions, plans, scope, documents, external context, or code that needs project-level explanation.

An entry is one `INSERT`. The serial and the date fill themselves; you supply the type, the area, and the description:

```sh
sqlite3 changes.db "INSERT INTO entries (type, area, description) VALUES ('decision','queue','Retry moved to the gateway; per-client retry double-billed the API');"
```

With a commit, PR, or issue reference:

```sh
sqlite3 changes.db "INSERT INTO entries (type, area, description, refs) VALUES ('code','api','Moved retry logic into ApiClient; callers no longer handle 429s','abc1234');"
```

Double every single quote inside the text (`don''t`, `it''s`). That is the whole quoting rule, and it is the sanctioned pattern for these writes.

Fields:

- `serial` — an ascending integer the database assigns. Never reused, never renumbered, never edited. This is what lets one entry reference another.
- `date` — defaults to today's local date. Do not pass it by hand.
- `type` — one of the six below.
- `area` — one of the areas listed in `BRIEFING.md`, or `-` when none fits. The `areas` table is a closed vocabulary and a trigger enforces it: an unknown area aborts the insert instead of silently creating a second spelling of an existing facet. `$close` adds an area to the table when `BRIEFING.md` gains one. An area is never renamed or removed — immutable entries already reference it, and the database refuses both. If work keeps landing outside the list, propose adding an area at the next `$close`.
- `description` — free text, one line, never empty.
- `refs` — optional: a commit, PR, or issue.

Types:
- `decision`: architectural, design, or process choice made; name the rejected alternative when one exists (`X over Y; reason`)
- `plan`: plan created or revised
- `doc`: document added, updated, or removed
- `scope`: scope added, removed, or clarified
- `code`: code change that needs project-level context git alone can't convey
- `note`: external context, blocker, handoff, or a finding still open — not a record of work already finished

Relationships between entries live in the `links` table, never inside an entry. Recording that entry 57 supersedes 41, or that it closes an open note 43, is an `INSERT` — never an edit, which is why property 2 needs no exception:

```sh
sqlite3 changes.db "INSERT INTO links VALUES (57, 41, 'supersedes');"
sqlite3 changes.db "INSERT INTO links VALUES (57, 43, 'closes');"
```

The `from` serial is always the later entry. A link naming a serial that does not exist is refused. The `log_lines` view renders links after the description as `supersedes=041` / `closes=043`, so an entry reads as a single line without any line ever having been rewritten.

Four rules keep the log honest.

1. **Supersession links, never deletes** — property 2, applied. A log entry records that something happened; a later reversal does not make it untrue. When a decision replaces an earlier one, insert the new decision and then insert a `supersedes` link naming the entry it replaces, leaving that entry untouched. Then update `BRIEFING.md` in the same session, because the brief is where the live decision has to end up: the log now holds both, and by property 4 it is not the thing that says which one counts.
2. **No verification receipts.** Test counts, measured distributions, "0 failures across N runs", console-clean confirmations: these belong in the COMPLIANCE `Verified:` line of your response, never in this file. Their value expires the moment the code they cover changes. Record a measurement only when the measurement itself is an open decision (an unresolved perf number, a limit nobody has ruled on).
3. **No parameter narration.** If code, config, or an asset file is authoritative for a value, do not copy it here — the copy goes stale silently and future sessions trust it. Record why a value is the way it is, never what it currently is.
4. **Record the lesson, not the incident.** Session conduct, frustration, blame and blow-by-blow correction history are not project records. When something went wrong and taught something durable, record the transferable part — as a `[note]` if it is an environment trap, or as the rejected alternative's reason inside the `[decision]` entry you are writing now. Never go back and edit an existing entry to absorb it; property 2 forbids that, and the database refuses it. "Approach X was abandoned; the API bills per generation and the account had no credit" earns its place. "Third attempt at X failed and the user was unhappy" does not.

These four carry a consequence worth stating outright: nothing ever cleans up the log. There is no compaction pass that will later remove a receipt or a narrated parameter, so junk has to be refused at authoring time — an entry is permanent the instant the `INSERT` returns. The only fix for a bad entry is a better later entry, with a `supersedes` link where one applies.

Openness is not a field, because a field would have to be edited and property 2 forbids that. A `[note]` stays open until a later entry inserts a `closes` link naming its serial.

Querying the log is how you reach anything past the last five entries. Do this when a specific question calls for it, never to gather background:

```sh
# every decision ever recorded
sqlite3 -readonly changes.db "SELECT line FROM log_lines WHERE serial IN (SELECT serial FROM entries WHERE type='decision');"
# everything that touched one area
sqlite3 -readonly changes.db "SELECT line FROM log_lines WHERE serial IN (SELECT serial FROM entries WHERE area='auth');"
# an entry and whatever references it
sqlite3 -readonly changes.db "SELECT line FROM log_lines WHERE serial IN (SELECT from_serial FROM links WHERE to_serial=41) OR serial=41;"
# notes still open (no later entry closes them)
sqlite3 -readonly changes.db "SELECT line FROM log_lines WHERE serial IN (SELECT serial FROM entries e WHERE type='note' AND NOT EXISTS (SELECT 1 FROM links WHERE to_serial=e.serial AND kind='closes'));"
# live decisions (never superseded)
sqlite3 -readonly changes.db "SELECT line FROM log_lines WHERE serial IN (SELECT serial FROM entries e WHERE type='decision' AND NOT EXISTS (SELECT 1 FROM links WHERE to_serial=e.serial AND kind='supersedes'));"
```

Anything a query turns up is still history, not instruction. If a result and `BRIEFING.md` disagree, the brief is right and the log is old — or the brief is stale and needs a `$close`. The log never wins that comparison.

Good entries, as `log_lines` renders them:

- `2026-05-12 041 [decision] (queue) Switched queue from Redis to Postgres SKIP LOCKED; one less service to operate`
- `2026-05-18 042 [scope] (sync) Dropped offline mode; sync complexity not worth it for v1`
- `2026-05-20 043 [note] (billing) Stripe sandbox webhooks flaky this week; retries can look like test failures`
- `2026-06-02 057 [decision] (queue) Retry moved to the gateway; per-client retry double-billed the API  supersedes=041`
- `2026-06-04 058 [note] (billing) Stripe sandbox stabilized after their incident closed  closes=043`

Bad entries:

- `2026-05-12 044 [code] (-) fixed bug` — belongs in a commit message; tells a future session nothing.
- `2026-05-12 045 [code] (ingest) batchSize 100 -> 500, timeout 30s -> 60s` — the config file is authoritative and this copy will rot. Record the reason, not the number.
- `2026-05-12 046 [note] (-) Verified: 200/200 cases valid, suite green, console clean` — evidence for one report on one day. It goes in the response, not the record.
- `2026-05-12 047 [decision] (authentication) Use JWTs` — the area list says `auth`. The trigger aborts this insert; adding `authentication` to the `areas` table to force it through would silently split the facet in two.

The first three are what makes the "refuse it at authoring time" rule load-bearing: none of them can be taken back.

`BRIEFING.md`: Update if scope or decisions changed, or on a breaking change (note reason and impact). Current focus, Next steps, and Environment quirks are refreshed by `$close`. `Open questions` is added to or edited only with the user's explicit consent, in `$close` or at any other time: propose the exact addition or removal, write it only after a clear yes, and otherwise leave the field exactly as it is. An instruction the user gave earlier this session counts as consent.

`Areas` is the closed vocabulary that `changes.db` tags against, and it lives in two places that must agree: the `- Areas:` line in the brief, and the `areas` table. Extending it means adding it to both (`$close` does this). Never rename or remove an area that existing log entries already use — the log is immutable, so a rename orphans every entry tagged with the old name, and the database refuses both outright.

It holds current state, never history — history is the log's job. It is read in full at every session start, so it is bounded by shape rather than by count. Four rules keep it that way:

- **One bullet per field, one line each.** A field's value is a sentence or a short list of clauses, matching the example brief in `.agents/skills/klawde/SKILL.md`. No sub-bullets, no paragraphs, no dated entries. A field that seems to need more is holding history or working notes; the fix is to move content out, never to restructure the field. `$klawde` stops on a field that breaks this, as it stops on a scope contradiction, and `$close` measures every field and will not finish with one over a line.
- Exactly **one** `Current focus`, present tense. Sessions **replace** it; they never append a dated one alongside.
- **Every field has an outflow.** `Next steps` and `Open questions` are kept true: remove what is done or answered (for `Open questions`, only with the user's consent, as above), and never drop a live item to hit a count. `Key decisions` holds the decisions that currently hold: when a decision is superseded, its replacement enters the brief and the old one leaves — the log keeps both, plus the link. `Breaking-change context` holds only what a new contributor still has to know to work on the code today; once the old form is gone from every place a session could meet it, the entry goes. `Environment quirks` holds what is still true; a quirk that no longer bites is removed.
- **No narration and no working notes.** A bullet that narrates a past session (`Styling pass`, `Auth refactor`, `Cleanup pass`) belongs in `changes.db`. Findings, progress, verification results, and things tried belong in the response. The brief is not a scratchpad: if a line would not help a new contributor understand what is true now, it does not go in.

---

## Output Format

Every response that completes a unit of work in which files were created or modified ends with the block below. Exceptions: intermediate mid-task responses (use the `In progress; verification pending` line instead), and responses from the `$klawde`, `$klaude`, and `$close` commands, which use the exact closing output defined in their own command files.

```
---
COMPLIANCE:
- Assumptions: [list; omit this line entirely if none]
- Verified: [the command you ran and its last output line | none, because X]
- changes.db: [appended NNN: "<rendered line>" | unchanged because X]
- BRIEFING.md: [updated: what changed; omit this line entirely if unchanged]
```

`Verified` and `changes.db` are always present; the other two lines appear only when they carry content. The `Verified` field must contain evidence, not a claim: name the command and its result. Never assert a check you did not run; if none was run, write "none, because X".

Filled example (no assumptions were made and BRIEFING.md did not change, so those lines are omitted):

```
---
COMPLIANCE:
- Verified: `cargo check` exited 0, no warnings
- changes.db: appended 058: "2026-06-10 058 [code] (api) Moved retry logic into ApiClient; callers no longer handle 429s  refs=abc1234"
```

If you completed file changes and the COMPLIANCE block is missing, add it now (this does not apply to the exempt commands above).

---

## Skills

- `$klawde` : Run the entry protocol in full mode (Code craft active). See `.agents/skills/klawde/SKILL.md`.
- `$klaude` : Run the entry protocol in lean mode (Code craft inactive). See `.agents/skills/klaude/SKILL.md`.
- `$close` : Run the close protocol. See `.agents/skills/close/SKILL.md`.
