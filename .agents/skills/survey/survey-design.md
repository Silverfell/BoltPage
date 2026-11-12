# Design it twice

Used from step 8 of the survey when the shape of the deepened interface is the open question and the user has said yes. The first design is rarely the best, so several are produced in parallel and compared. Nothing here is written into the project.

Paths in this file are relative to this skill's folder.

## Steps

1. **Frame.** Write for the user: the constraints any new interface must satisfy; the dependencies it relies on, each with its category from `survey-report.md`; and a rough sketch in a code block that grounds the constraints, with `<placeholder>` names. The sketch is not a proposal. Show it and proceed to step 2 at once; the user reads while the designs are produced. Done when the frame is shown.

2. **Dispatch.** Dispatch three or more subagents in parallel, one per constraint:

   - A: the smallest interface, one to three entry points, maximum leverage per entry point.
   - B: the most flexible interface, many uses and extension.
   - C: the most common caller's case made trivial.
   - D, when a dependency crosses a seam: ports and adapters.

   Each brief carries, verbatim: the Vocabulary and Principles sections of `survey-report.md`; the `Areas` line and the relevant `Key decisions` lines; the candidate's files, friction, dependency category and what sits behind the seam; the decisions settled so far in the interview; its one constraint; and this return form:

```
Design <letter>: <name>
Interface: <types, methods, parameters; invariants, ordering, error modes>
Usage: <how a caller uses it>
Hidden: <what the implementation hides behind the seam>
Dependencies: <category; the production adapter; the test adapter>
Trade-offs: <where leverage is high; where it is thin>
```

   Where the harness offers no subagents, do this inline in the same form, one constraint at a time. Done when every constraint has a design.

3. **Present and compare.** Present the designs one at a time. Then compare them on depth, locality and seam placement, and give one recommendation, or a hybrid when parts of two designs combine well. Be opinionated. Done when every design and the recommendation are shown.

4. **Decide and keep.** The pick is the user's, and it is one decision in the interview's tree. Append the designs and the comparison to the survey's report file as a `<section id="designs">` after `#top`, headed "Designs", with no `candidate` class and no `data-strength` attribute in it. Return to the interview. Records change only through the interview's record step; an approved task's text names the chosen shape. Done when the user has picked and the report carries the designs.
