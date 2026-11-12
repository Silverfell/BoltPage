---
name: survey
description: Survey the codebase for shallow modules that could be deepened, report them as HTML outside the project, then interview you through the one you pick.
disable-model-invocation: true
---

# survey: Architecture Survey

Find where a shallow module could become a deep one, report the candidates, and interview the user through the one they pick. The survey changes no code and writes nothing into the project: the report lives in the OS temp directory. Records change only on the user's word.

Paths in this file are relative to this skill's folder.

## Steps

1. Check the contract version before anything else:

```sh
cat CLAUDE.md AGENTS.md 2>/dev/null | grep -q '^<!-- klawde:begin v2 '
```

   No match: stop. "This project's klawde contract is missing or older than this harness (needs v2). Run upgrade.sh from the klawde checkout, then retry." If the same command with `v[3-9]` in place of `v2` matches, stop. "The contract is newer than this harness; run upgrade.sh." Done when the check passed or the protocol stopped.

2. **Read the references.** Read `survey-report.md` in full: its vocabulary and heuristics drive the exploration, the rest drives the report. Read `survey-design.md` only when step 8 reaches it. Read `BRIEFING.md` completely, and `guidelines.md` if it exists. A missing record does not block a read-only survey: say so in one line and use file and directory names where `Areas` would supply names. Done when the vocabulary, the `Areas` line and the `Key decisions` line are in context.

3. **Scope.** A direction from the user wins: a module, a subsystem, a pain point, an upcoming change. Otherwise find the hot spots:

```sh
git log -n 200 --name-only --pretty=format: | grep -v '^$' | sort | uniq -c | sort -rn | head -30
```

   Group the paths into areas, using the `Areas` names. When the changes are scattered, or this is not a git repository, the scope is the whole tree. State the scope in one line and proceed. Done when the scope is a list of paths or areas.

4. **Explore by subagent.** Dispatch one exploration subagent per scoped area, in parallel, and wait for all of them. Each brief carries, verbatim: the Vocabulary, Principles and Heuristics sections of `survey-report.md`; the `Areas` and `Key decisions` lines; the area's paths; the instruction to read and change nothing; and this return form, one block per candidate:

```
Candidate: <title naming the deepening>
Files: <paths>
Friction: <what hurts, one or two sentences>
Deletion test: <what concentrates when the module is deleted>
Dependencies: <in-process | local-substitutable | remote-owned | external>
Conflicts: <the Key decisions line it contradicts | none>
```

   Zero candidates is a valid return. Subagents point at code by file path and never paste it. Where the harness offers no subagents, do this inline in the same form. Done when every area has returned.

5. **Judge.** Candidates are judgment, not facts. Keep only those that pass the deletion test, merge duplicates, and give each a strength: Strong, Worth exploring or Speculative. A candidate that contradicts a `Key decisions` line keeps a callout quoting that line and carries no argument against the decision. Zero kept candidates is a valid result. Done when every kept candidate has a strength and a dependency category.


6. **Report.** Write the report as `survey-report.md` describes, to the OS temp directory (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows), as `survey-<project>-<YYYYMMDD-HHMMSS>.html`, where `<project>` is the working directory's name. Open it (`open <path>` on macOS, `xdg-open <path>` on Linux, `start <path>` on Windows) and print its absolute path. Propose no interfaces. Measure the counts from the file:

```sh
grep -c '<article class="candidate"' <path>
grep -c 'data-strength="strong"' <path>
grep -c 'data-strength="exploring"' <path>
grep -c 'data-strength="speculative"' <path>
```

   Done when the file exists, it is open or its path is printed, and the counts are measured.

7. **Ask.** With zero candidates, go to step 9. Otherwise stop and ask which candidate to explore, by title. Wait. "None" goes to step 9. Done when the user has answered.

8. **Interview the pick.** Read `../interrogate/SKILL.md` and follow it, with the chosen candidate as the subject. The tree covers the constraints, the dependency category, what sits behind the seam, which tests survive, and the shape of the interface. When the shape of the interface is the open question, offer design it twice; on yes, follow `survey-design.md`, then return to the interview. When the user rejects the candidate, ask one question, "Is this a standing directive?", and only on yes propose the exact `Key decisions` line. Approved work becomes a `tasks` row, proposed as the exact line. The interview's record step makes every write. One candidate per survey: the others stay in the report, and become rows only if the user approves each as a task. Done when the interview has printed its closing block.

9. Output this format, then stop:

```
Survey complete.
Report: <absolute path>
Candidates: <N> (<N> strong, <N> worth exploring, <N> speculative)
Explored: <candidate title | none>
Recorded: <tasks #<id> | BRIEFING.md Key decisions: "<line>" | nothing>
```

   The counts are the grep results. `Recorded` repeats what the interview wrote, with identifiers read back from the database, never expected values.
