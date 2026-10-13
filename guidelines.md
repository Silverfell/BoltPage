# guidelines.md

How code is written in this project. These are klawde's defaults; the file is yours after install. Edit it, cut it down, or replace it with your own rules — an upgrade never writes this file, and deleting it turns these rules off. The entry protocol reads it at session start when it is there, and says nothing when it is not.

---

## Deviations

A default in Scope, Code, Code craft, or Decision Rules may be deviated from when the situation requires it, labeled inline and kept contained; a silent deviation is not allowed.

- `TYPE:` a cast or `any` the type system forced.
- `REASON:` why a default (broad catch, per-iteration query) was the right call here.

A fact is never assumed. Look it up or run it. When that is impossible, ask the user, or say under `Verified:` that it was not checked.

---

## Core rules

1. No secrets, credentials, or environment-specific values in code. Use config or env.
2. All SQL through parameterized queries. No string concatenation into SQL. Ever. (The harness's own `sqlite3` statements follow the contract's Writing SQL safely instead.)
3. Verify before reporting completion (see Completion & Verification).

---

## Scope & Communication

- Complete the request first. Offer at most one alternative, only if it materially matters, with a one-line trade-off, then wait for the user's decision.
- Keep diffs minimal and preserve public APIs unless authorized otherwise.
- If a fix requires changes beyond the immediate scope, state the refactor boundary and wait for approval before proceeding.
- Do not volunteer stylistic improvements, speculative features, or observations about code the task did not touch; they are neither stated nor recorded. Exception: a correctness, security, or data-loss risk is stated in one line, once, and left to the user. The exception does not authorize investigating it further.
- Ask all independent blocking questions together in one response. Ask one at a time only when the answer to one decides whether the next applies.
- No filler, no fake empathy, no unsolicited timeline estimates (give one if asked).
- Write in plain English. Use a technical term only where it names something more precisely than plain words would; do not reach for jargon to sound expert.

---

## Code

These rules govern lines you write or modify; match the existing code style even where you would write it differently, and do not rewrite pre-existing violations elsewhere unless asked. Stack-specific rules (DOM) apply only when the project uses that stack.

- Before creating a file, verify it does not exist.
- Parameterize values that vary by environment rather than hardcoding. Never hardcode to mask a bug.
- Sanitize before use: no unsanitized input in shell or process calls; no raw user input rendered into the DOM (use framework escaping).
- Remove imports, variables, and functions your changes made unused. Leave pre-existing dead code unless asked.

---

## Code craft (optional module)

Opinionated code-quality defaults. To drop them permanently, delete this whole section.

- Catch specific errors and handle them. A broad catch is allowed only at process boundaries (top-level handlers, worker loops) and must log; a broad catch elsewhere written to match surrounding code must be marked `REASON:`.
- Run independent async work concurrently. Sequential awaits are fine when the work is dependent or when ordering, rate limits, or backpressure require it.
- Batch queries rather than issuing one per iteration, unless batching is infeasible (cursor pagination, variable batch sizes); then mark `REASON:`.
- Keep types honest: fix the type rather than casting. If a third-party or mid-migration type cannot be fixed cheaply, use a localized cast marked `TYPE:`.
- Migrations follow the project's migration tool and conventions; where nothing tracks which migrations have run, write them idempotent.
- No abstractions for single-use code. No error handling for impossible states.

---

## Tools

- Prefer locally installed CLI tools (psql, docker, gh) over MCP equivalents when available.
- An equivalent tool substitution (grep for rg) is fine. Do not switch the *approach* to the task to route around a missing tool. If something you need is missing, state what you need.

---

## Architecture

- Prefer simple solutions. Do not introduce infrastructure the task does not require (new services, queues, schedulers, orchestration, infrastructure-as-code) unless the user asks. When in doubt, propose the simpler approach.

---

## Audits & reviews

- When asked to review or audit, raise issues affecting correctness, security, reliability, or maintainability. Calibrate severity honestly: reserve "critical" for data loss, security breaches, or crashes.

---

## Decision Rules

- **Certainty gate**: before starting any non-trivial task, state in one line each: the deliverable, the acceptance test, and the files or areas it touches. When all three are immediately statable, proceed — the gate pauses nothing that is already clear.
  - When a line cannot be filled, first check whether the repo, `BRIEFING.md`, a project document, or a targeted log query fills it; asking the user something you could have looked up violates these rules. A gap only the user can close — intent, priorities, a trade-off between valid options, external context — is a blocking question: ask all such questions batched, wait, then proceed. Never fill a gate line by guessing intent.
- **Below the gate, everything is minor**: once the three lines are stated, every remaining unknown — naming, formatting, defaults, a choice between equivalent approaches — is resolved by picking a reasonable option and proceeding. Do not ask about these, label them or record them. A mid-task unknown reopens the gate only if it invalidates one of the three stated lines.
- **No acceptance criteria**: when intent is clear but no criterion was given, fill that gate line yourself: state "Acceptance test: [X]" and build to it. The missing criterion blocks only when intent itself is unclear.
- **Settled decisions**: a decision stated in the brief's `Key decisions`, or in a project document the brief points to, is not reopened. If you believe it is wrong, or found a case it does not cover, say so in one line and proceed under it unless the user overrules. The log never authorizes anything. When two statements that both apply to the task cannot both hold, and the difference affects the work, raise it as a blocking question; a superseded decision is resolved history, and a detail the brief omits is not a conflict.
- **Multi-step task**: state a brief plan as `1. [step] → verify: [check]`, then implement, fixing your own failures as you go until each check passes.
- **A check or command fails**:
  - If it failed because of the change you are making, fix it and continue. That is the loop.
  - Circuit breaker: after three attempts at the same failing check without new information, stop. Present your diagnosis to the user — the error, which approaches failed and why — and do not keep grinding. Nothing is logged for it.
  - If it is an environmental failure (missing tool, network, permission, config you did not touch): retry once if it looks transient, otherwise report the exact error and stop. Do not switch approach, change unrelated config, or alter scope to work around it. (Installing a dependency the task requires is part of the task, not a workaround.)

---

## Completion & Verification

- Before reporting work complete, run the project's lint/build/test checks (e.g. `flutter analyze`, `cargo check`, the test suite).
- Report verification scaled to what you actually ran. Say "This works." only if you executed the actual behavior. Otherwise state the real evidence: "Builds and lint pass; not run." or "Tests pass: `cargo test` 42/42." Never claim a check you did not run.
