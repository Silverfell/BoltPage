# AGENTS.md

## Project Records

All paths relative to working directory.

- **BRIEFING.md**: Project scope, decisions, non-goals. Read completely on session start.
- **CHANGES.md**: Append-only project journal (decisions, plans, scope, docs, notes, code). Read last 30 lines on session start.

If either file is missing, stop and tell the user to run `$klawde` before continuing with any task that modifies files; read-only questions may be answered first. Running `$klawde` itself is exempt: it creates these files.

---

## Rules

### Non-negotiable core

These hold in every context. Everything below them is secondary.

1. If you don't know, say "I don't know." If uncertain, say "I am uncertain." If you cannot deliver, say so.
2. Never assume the state of files or configurations. Read the actual files before making claims or recommendations.
3. No secrets, credentials, or environment-specific values in code. Use config or env.
4. All SQL through parameterized queries. No string concatenation into SQL. Ever.
5. After making code changes, run the project's lint/build checks before reporting completion (e.g., `flutter analyze` for Flutter, `cargo build` or `cargo check` for Rust).
6. Minimal diffs. Preserve public APIs unless authorized otherwise.

### Scope

- Complete the request first. Alternatives come after, if they materially matter, one only, with a one-line trade-off. Wait for user decision.
- If the code works, say "This works.", then a short factual summary of what changed, then the COMPLIANCE block. No commentary beyond what these Scope rules allow.
- Do not suggest improvements, edge cases, or future concerns unless asked.

### Communication

- One question per response.
- No filler, no fake empathy, no timeline estimates.
- No em dashes. Use commas, colons, or parentheses instead.

### Code

Rules referencing a specific stack (DOM, TypeScript, migrations) apply when the project uses that stack.

- Before creating any file, verify it doesn't exist. State what you checked.
- No hardcoding to mask bugs. Parameterize.
- Label assumptions as "ASSUMPTION:" and isolate them.
- If a fix requires changes beyond the immediate scope: state the refactor boundary and wait for approval before proceeding.
- All migration files must be idempotent.
- Catch specific errors. Never catch-and-ignore. A broad catch is allowed only at process boundaries (top-level handlers, worker loops) and must log.
- No unsanitized input in shell commands or process calls.
- No raw user input rendered into DOM. Sanitize or use framework escaping.
- No awaiting inside loops unless ordering, rate limits, or backpressure require it. State the reason in a one-line comment.
- No queries inside loops unless batching is infeasible (cursor pagination, variable batch sizes). State the reason in a one-line comment.
- No `any`, no type casts to bypass the compiler. Fix the type.
- No abstractions for single-use code. No error handling for impossible scenarios.
- Match existing code style, even if you would write it differently. The Code rules above apply to lines you write or modify; do not rewrite pre-existing violations elsewhere unless asked.
- Remove imports, variables, and functions that your changes made unused. Do not remove pre-existing dead code unless asked.

### Tools

- Prefer locally installed CLI tools over MCP equivalents (e.g. psql, docker, gh) when they are available on the system.
- If a required tool is missing, state what you need. Do not improvise alternatives.

### Architecture & Planning

- Prefer simple solutions over complex architectures. Do not introduce unnecessary infrastructure (KEDA, container orchestration, heartbeat tables, IaC) unless the user explicitly asks for it. When in doubt, propose the simpler approach.

### UI & Design Implementation

- If this project has UI work: implement design changes as full structural implementations, not lazy shortcuts like color swaps or minimal tweaks. Match the design spec faithfully including gradients, transparency, layout structure, and positioning.

### Code Audits & Bug Fixes

- When reviewing or auditing code, calibrate severity ratings honestly. Do not inflate issues to "critical" unless they cause data loss, security breaches, or crashes. Reserve "critical" for what is actually critical.

---

## Decision Rules

- **Underspecified request (scope-level)**: If the ambiguity changes what gets built, ask one question. Wait.
- **Underspecified request (minor)**: For naming, formatting, default values, or a choice between equivalent approaches, pick a reasonable option and state "ASSUMPTION: [X]". Do not ask.
- **No acceptance criteria**: State "Acceptance test: [X]" then implement to that.
- **Must assume**: State "ASSUMPTION: [X]" and isolate it in code.
- **Code works**: Say "This works.", summarize what changed, then COMPLIANCE block. Stop.
- **User asks for review**: Raise issues only if they affect correctness, security, reliability, or maintainability.
- **Offering an alternative**: Confirm request is complete first. One alternative. One-line trade-off. Wait.
- **Multi-step task**: State a brief plan with verifiable checks before implementing. Format: `1. [Step] → verify: [check]`. Loop until each check passes.
- **Command or tool fails**: If the failure looks transient (network, lock, flaky test), retry the same command once. Otherwise, or if the retry fails, report the exact error and stop. Do not switch to a different approach, install packages, change configs, or alter scope to work around the failure.

---

## Documentation Updates

`CHANGES.md` is a typed project journal, not a git log. Append an entry whenever any of these shift: decisions, plans, scope, documents, external context, or code that needs project-level explanation.

Entry format (one line, max 200 characters total): `YYYY-MM-DD [type] description`

Types:
- `decision`: architectural, design, or process choice made
- `plan`: plan created or revised
- `doc`: document added, updated, or removed
- `scope`: scope added, removed, or clarified
- `code`: code change that needs project-level context git alone can't convey
- `note`: external context, blocker, incident, handoff

Good entries:

- `2026-05-12 [decision] Switched queue from Redis to Postgres SKIP LOCKED; one less service to operate`
- `2026-05-18 [scope] Dropped offline mode; sync complexity not worth it for v1`
- `2026-05-20 [note] Stripe sandbox webhooks flaky this week; retries can look like test failures`

Bad entry: `2026-05-12 [code] fixed bug` (belongs in a commit message; tells a future session nothing).

`BRIEFING.md`: Update if scope or decisions changed, or if breaking change (note reason and impact).

---

## Output Format

Every response in which files were created or modified ends with the block below, except responses from the `$klawde`, `$close`, and `$compresschanges` commands, which use the exact closing output defined in their own command files:

```
---
COMPLIANCE:
- Assumptions: [list | none]
- Verified: [the command you ran and its last output line | none, because X]
- CHANGES.md: [appended lines, quoted verbatim | unchanged because X]
- BRIEFING.md: [updated: what changed | unchanged because X]
```

The `Verified` field must contain evidence, not a claim: name the command and its result. Never assert a check you did not run; if none was run, write "none, because X".

Filled example:

```
---
COMPLIANCE:
- Assumptions: none
- Verified: `cargo check` exited 0, no warnings
- CHANGES.md: appended: 2026-06-10 [code] Moved retry logic into ApiClient; callers no longer handle 429s
- BRIEFING.md: unchanged because scope did not shift
```

If you changed files and the COMPLIANCE block is missing, add it now (this does not apply to the exempt commands above).

---

## Skills

- `$klawde` : Run the entry protocol. See `.agents/skills/klawde/SKILL.md`.
- `$close` : Run the close protocol. See `.agents/skills/close/SKILL.md`.
- `$compresschanges` : Compact CHANGES.md history. See `.agents/skills/compresschanges/SKILL.md`.
