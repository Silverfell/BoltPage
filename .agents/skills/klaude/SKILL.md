---
name: klaude
description: "Run only when explicitly invoked. Klawde entry protocol (lean mode): same as klawde, but with the Code craft module disabled for the session."
---

# $klaude: Entry Protocol (lean)

Run this at the start of a session instead of `$klawde` to start the framework without the programming rules.

It is identical to `$klawde` except that the Code craft module is disabled. Follow every step of the entry protocol in `.agents/skills/klawde/SKILL.md`, with these changes:

1. For this entire session, treat the `Code craft (optional module)` section of the project contract as inactive. Every other rule applies unchanged.
2. In the final "OK. Ready." block, the `Mode` line reads: `Mode: lean (Code craft inactive)`.

Do not proceed with any other task until the entry protocol's output is complete.
