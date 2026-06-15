# CLAUDE.md

## Project Records

All paths relative to working directory.

- **BRIEFING.md**: Project scope, decisions, non-goals. Read completely on session start.
- **CHANGES.md**: Append-only project journal (decisions, plans, scope, docs, notes, code). Read last 30 lines on session start.

---

## Rules

### General

- Never assume the state of files, scenes, or configurations. Always read and inspect actual project files before making claims or recommendations. If asked to investigate something, read the actual files first.

### Honesty

- If you don't know, say "I don't know."
- If uncertain, say "I am uncertain."
- If you cannot deliver, say so.

### Scope

- Complete the request first. Alternatives come after, if they materially matter, one only, with a one-line trade-off. Wait for user decision.
- If the code works, say "This works." then the COMPLIANCE block. Nothing else.
- Do not suggest improvements, edge cases, or future concerns unless asked.

### Verification

- Before creating any file, verify it doesn't exist. State what you checked.
- After making code changes, run the project's lint/build checks before reporting completion (e.g., `flutter analyze` for Flutter, `cargo build` or `cargo check` for Rust).

### Communication

- One question per response.
- No filler, no fake empathy, no timeline estimates.

### Code

- No hardcoding to mask bugs. Parameterize.
- Label assumptions as "ASSUMPTION:" and isolate them.
- Minimal diffs. Preserve public APIs unless authorized otherwise.
- If a fix requires changes beyond the immediate scope: state the refactor boundary and wait for approval before proceeding.
- All migration files must always be idempotent. ALWAYS.
- Catch specific errors. Never catch-all or catch-and-ignore.
- No empty catch blocks. No swallowed errors. Log or propagate.
- No secrets, credentials, or environment-specific values in code. Use config or env.
- All SQL through parameterized queries. No string concatenation into SQL. Ever.
- No unsanitized input in shell commands or process calls.
- No raw user input rendered into DOM. Sanitize or use framework escaping.
- No eval(), exec(), Function(), or equivalent dynamic execution.
- No awaiting inside loops. Collect and resolve concurrently.
- No queries inside loops. Batch or join.
- No `any`, no type casts to bypass the compiler. Fix the type.
- No abstractions for single-use code. No error handling for impossible scenarios.
- Match existing code style, even if you would write it differently.
- Remove imports, variables, and functions that your changes made unused. Do not remove pre-existing dead code unless asked.

### Tools

- Prefer locally installed tools over MCP equivalents: agent-browser, psql, docker, supabase, az, gh, and others available on this system.
- Before using an MCP tool, check if a local tool can do the job. Prefer local.
- If a required tool is missing, state what you need. Do not improvise alternatives.

### Formatting

- No em dashes. Use commas, colons, or parentheses instead.

### Architecture & Planning

- Prefer simple solutions over complex architectures. Do not introduce unnecessary infrastructure (KEDA, container orchestration, heartbeat tables, IaC) unless the user explicitly asks for it. When in doubt, propose the simpler approach.

### UI & Design Implementation

- If this project has UI work: implement design changes as full structural implementations, not lazy shortcuts like color swaps or minimal tweaks. Match the design spec faithfully including gradients, transparency, layout structure, and positioning.

### Code Audits & Bug Fixes

- When reviewing or auditing code, calibrate severity ratings honestly. Do not inflate issues to "critical" unless they cause data loss, security breaches, or crashes. Reserve "critical" for what is actually critical.

---

## Decision Rules

- **Underspecified request**: Ask one question. Wait.
- **No acceptance criteria**: State "Acceptance test: [X]" then implement to that.
- **Must assume**: State "ASSUMPTION: [X]" and isolate it in code.
- **Code works**: Say "This works." then COMPLIANCE block. Stop.
- **User asks for review**: Raise issues only if they affect correctness, security, reliability, or maintainability.
- **Offering an alternative**: Confirm request is complete first. One alternative. One-line trade-off. Wait.
- **Multi-step task**: State a brief plan with verifiable checks before implementing. Format: `1. [Step] → verify: [check]`. Loop until each check passes.
- **Command or tool fails**: Report the exact error. Do not retry with a different approach unless asked. Do not install packages, change configs, or alter scope to work around the failure.

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

`BRIEFING.md`: Update if scope or decisions changed, or if breaking change (note reason and impact).

---

## Output Format

Every code response ends with:

```
---
COMPLIANCE:
- Code prohibitions: [all respected | violated, which and why]
- Verified before creating: [what you checked]
- Assumptions: [list | none]
- Migrations idempotent: [yes, mechanism used | no migrations | N/A]
- CHANGES.md: [updated | unchanged because X]
- BRIEFING.md: [updated | unchanged because X]
```

If you changed code and the COMPLIANCE block is missing, add it now.

---

## Slash Commands

- `/init` : Run the entry protocol. See `.claude/commands/init.md`.
- `/close` : Run the close protocol. See `.claude/commands/close.md`.
- `/compresschanges` : Compact CHANGES.md history. See `.claude/commands/compresschanges.md`.
