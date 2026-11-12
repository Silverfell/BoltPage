---
name: kleanup
description: Cut history, scrapbooking and needless detail from the documentation and code comments. Changes prose only, leaves the records alone, and leaves the diff uncommitted.
argument-hint: "<paths or area; empty for the whole tree>"
disable-model-invocation: true
---

# kleanup: Text Sweep

Documentation and comments state what is true now. How a thing came to be belongs to git and the log. Find the text that breaks this and cut it. Running this command is the approval: there is no review step, and git is the undo. This command changes no executable line, writes no record and commits nothing.

## Classes

Judge each passage against the current code, by what it is about and never by the words it uses.

- **History**: about an event, not a state: how this came to be, what it replaced, what was tried, who or when.
- **Scrapbook**: raw material rather than documentation: working notes, thinking aloud, pasted output, commented-out code.
- **Detail**: true now, but it changes nothing for a reader: it repeats the adjacent code, repeats a fact stated elsewhere, or nobody using or changing this would act differently without it.

## What stays

- A fact inside a flagged passage. A reason, limit or warning that still holds stays where it is, in the present tense, and only the story around it goes. A reduction only cuts; it adds no claim. A decision carried by a comment stays carried.
- The records and harness files: `BRIEFING.md`, `changes.db`, `guidelines.md`, `klawde-sql.md`, and the marked klawde contract block wherever it sits.
- Documents whose purpose is history: decision records, changelogs, release notes.
- Text a tool or a rule reads: pragmas, directives, shebangs, `TYPE:` and `REASON:` labels, license text, documentation examples that run.
- Markers of open work. Whether they are worth doing is the user's call, not this command's.
- Generated, vendored and fixture files.
- Anything you are unsure about. Doubt keeps the passage.

A cut passage leaves the tree. It is never moved to another file.

## Steps

1. Check the contract version before anything else:

```sh
cat CLAUDE.md AGENTS.md 2>/dev/null | grep -q '^<!-- klawde:begin v2 '
```

   No match: stop. "This project's klawde contract is missing or older than this harness (needs v2). Run upgrade.sh from the klawde checkout, then retry." If the same command with `v[3-9]` in place of `v2` matches, stop. "The contract is newer than this harness; run upgrade.sh." Done when the check passed or the protocol stopped.

2. **Preconditions.** Run `ls BRIEFING.md changes.db 2>/dev/null`. If either record is missing, stop and say "Run the `klawde` command first; it creates the records." Then:

```sh
git status --porcelain
```

   Any output, or not a git repository: stop and say "kleanup needs a clean git tree; git is what makes a cut recoverable." Read `BRIEFING.md` completely, and `guidelines.md` if it exists. Done when the tree is clean and the `Areas` and `Key decisions` lines are in context.

3. **Scope.** Paths or an area given with the command win; otherwise the whole tree. List it with `git ls-files`, then drop the files What stays exempts. State the file count in one line. Done when the scope is a list of files with a measured count.

4. **Sweep by subagent.** Dispatch one subagent per area, in parallel, and wait for all of them. Each brief carries, verbatim: the Classes and What stays sections; the `Key decisions` line; the area's files; the instruction to read every file whole and change nothing; and this return form, starting with the files read, then one block per candidate:

```
Read: <paths>

File: <path>
Lines: <start>-<end>
Class: <history | scrapbook | detail>
Action: <cut | reduce | delete file>
Keeps: <the sentence that remains | nothing>
```

   Zero candidates is a valid return. Where the harness offers no subagents, do this inline in the same form. Done when every file in scope appears under some `Read:`.

5. **Judge.** Read each candidate in its file and drop any that What stays protects. Check every `Keeps` sentence against the code: when you cannot tell, the passage stays; when the code contradicts it, the passage stays and joins the `Reported` list, because a wrong statement is a defect and not this command's to fix. Zero remaining candidates goes to step 8. Done when every candidate is confirmed, dropped or reported.

6. **Apply.** Make the confirmed cuts, in place. A removed file or heading leaves no dangling reference: search the tracked files for its name, and cut or repoint each hit. Done when every confirmed candidate is applied.

7. **Verify.** Measure the diff:

```sh
git diff --numstat
git diff --shortstat
git diff --name-only --diff-filter=D
```

   Every `--numstat` row has added at most equal to removed: a sweep never grows a file. Read the diff of every changed file: in a source file every changed line is a comment, and every reduction matches its `Keeps` sentence. A file that fails any of these tests is restored with `git restore <path>` and joins `Reported`. Then run the project's own lint, build and test commands. Done when every test holds for every remaining file and the commands have run.

8. Output this format, then stop:

```
Kleanup complete.
Read: <N> of <N> files
Applied: <N> (<N> history, <N> scrapbook, <N> detail)
Deleted files: <paths | none>
Diff: <the --shortstat line | none>
Checks: <the command run and its last output line | none, because X>
Reported: <one line per wrong statement or restored file | none>
```

   Every number comes from command output or the candidate list. The diff stays uncommitted: commit it to keep it, or run `git restore -- . ':!changes.db' ':!BRIEFING.md'` to undo all of it and leave the records as they are. The `close` command logs the work.
