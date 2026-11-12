# Survey report

The survey is one self-contained HTML file in the OS temp directory, never inside the project. This file is read in full before exploring: the vocabulary and heuristics drive the exploration, the rest drives the report.

## Where it goes

`<tmpdir>/survey-<project>-<timestamp>.html`, a fresh file on every run. `<tmpdir>` is `$TMPDIR`, else `/tmp`, or `%TEMP%` on Windows. Open it with `open`, `xdg-open` or `start`, and print the absolute path.

## Vocabulary

- **Module**: anything with an interface and an implementation, at any scale: a function, a class, a package, a slice across tiers.
- **Interface**: everything a caller must know to use the module correctly: the type signature, invariants, ordering, error modes, required configuration, performance.
- **Implementation**: the code inside a module.
- **Depth**: leverage at the interface, the behaviour a caller or test can exercise per unit of interface learned. A module is **deep** when much behaviour sits behind a small interface, **shallow** when the interface is nearly as complex as the implementation.
- **Seam**: the place where a module's interface lives, where behaviour can be altered without editing in that place. Where the seam goes is its own decision.
- **Adapter**: a concrete thing that satisfies an interface at a seam. It names a role, not a substance.
- **Leverage**: what callers gain from depth: more capability per unit of interface.
- **Locality**: what maintainers gain from depth: change, bugs and verification concentrate in one place.

A module has one interface. Depth is measured against that interface. A seam is where the interface lives. An adapter sits at a seam and satisfies the interface. Depth produces leverage for callers and locality for maintainers.

Use exactly: module, interface, implementation, depth, deep, shallow, seam, adapter, leverage, locality. Never substitute component, service, unit, layer or wrapper for module; API or signature for interface; boundary for seam.

## Principles

- **The deletion test.** Imagine deleting the module. If its complexity vanishes, it was a pass-through. If the complexity reappears across its callers, it was earning its keep.
- **Depth is a property of the interface.** A deep module may be built from small parts inside; they are not part of its interface.
- **The interface is the test surface.** Callers and tests cross the same seam. A test that has to reach past the interface means the module is the wrong shape.
- **One adapter means a hypothetical seam; two adapters mean a real one.** A seam with one adapter is indirection.
- **Design for testability.** Accept dependencies instead of creating them. Return results instead of producing side effects. Keep the surface small.

## Heuristics

- A concept that takes bouncing between many small modules to understand.
- An interface nearly as complex as its implementation.
- Pure functions extracted for testability while the bugs hide in how they are called.
- Coupled modules that leak across their seams.
- Code that is untested, or hard to test through its current interface.

Apply the deletion test to each suspect. "Concentrates" is the signal; "moves" is not.

## Dependency categories

- **in-process**: pure computation and in-memory state. Merge the modules and test through the new interface directly; no adapter.
- **local-substitutable**: a local stand-in exists for tests. Test the deepened module with the stand-in running; the seam stays internal.
- **remote-owned**: the project's own services across a network. Define a port at the seam: a network adapter in production, an in-memory adapter in tests.
- **external**: third-party services. The deepened module takes them as an injected port; tests use a mock adapter.

Replace tests, do not layer them: tests at the deepened interface replace the tests on the shallow modules, and assert observable outcomes through the interface.

## Scaffold

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Survey: <project></title>
<script src="https://cdn.tailwindcss.com"></script>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: true, theme: "neutral" });
</script>
<style>
.seam { stroke-dasharray: 4 4; border-style: dashed; }
.leak { stroke: #dc2626; color: #dc2626; }
.deep { background: linear-gradient(135deg, #0f172a, #1e293b); color: #f8fafc; }
</style>
</head>
<body class="bg-stone-50 text-slate-900 font-sans">
<main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
<header>...</header>
<section id="candidates" class="space-y-10">
<article class="candidate" id="<slug>" data-strength="<strong|exploring|speculative>" data-dependency="<category>">
...
</article>
</section>
<section id="top">...</section>
</main>
</body>
</html>
```

Each candidate is exactly one `<article class="candidate" ...>`, its opening tag on a line of its own, with `class` first. `data-strength` is one of `strong`, `exploring`, `speculative`; `data-dependency` is one of the four categories. These attribute names and values are fixed, and appear nowhere else in the file, because the survey's counts are measured from them. With zero candidates, `#candidates` holds one line: "No candidate passed the deletion test in <scope>."

## Header

Project name, date, scope, and a compact legend: solid box = module, dashed line = seam, red arrow = leak, thick dark box = deep module. No introduction paragraph.

## Candidate card

- **Title**: names the deepening.
- **Badge row**: strength (Strong emerald, Worth exploring amber, Speculative slate) and a tag for the dependency category.
- **Files**: monospaced list.
- **Before / After**: two diagrams side by side. The centrepiece.
- **Problem**: one sentence. What hurts.
- **Solution**: one sentence. What changes.
- **Wins**: bullets of six words or fewer, each naming locality, leverage or interface shrinkage.
- **Key decisions callout**: only when the candidate contradicts the brief. One line in an amber box, quoting the `Key decisions` line.

If a diagram needs a paragraph to be understood, redraw the diagram.

## Diagram patterns

Pick the pattern that fits each candidate, and vary them across the report.

- **Mermaid flowchart or sequence**, for call flow and dependencies. Colour leaks red and the deep module dark with `classDef`:

```html
<div class="rounded-lg border border-slate-200 bg-white p-4">
<pre class="mermaid">
flowchart LR
  A[<module>] --> B[<module>]
  B --> C[<module>]
  C -.leak.-> D[<module>]
  classDef leak stroke:#dc2626,stroke-width:2px;
  class C,D leak
</pre>
</div>
```

- **Boxes and arrows**: modules as bordered `<div>`s, arrows as inline SVG over a relative container. Use it when the after diagram is one thick deep module with faded internals.
- **Cross-section**: horizontal bands for the layers a call passes through. Before, many thin bands; after, one thick band.
- **Mass diagram**: two rectangles per module, interface and implementation. Shallow: nearly equal heights. Deep: a short interface over a tall implementation.
- **Call-graph collapse**: before, nested boxes of calls; after, one box with the calls faded inside it.

## Top recommendation

One larger card in `#top`: the candidate's title, one sentence on why it comes first, an anchor link to its card. No strength attribute and no `candidate` class on it. With zero candidates, omit the card.

## Style

Editorial, not a dashboard. Generous whitespace. One accent colour, plus red for leaks and amber for warnings. Diagrams about 320px tall so before and after sit side by side. Module labels in diagrams `text-xs uppercase tracking-wider`. The only scripts are the two CDN imports; the page is otherwise static.

## Tone

Plain sentences in the exact vocabulary. Forms that fit:

- "`<area>` module is shallow: interface nearly matches the implementation."
- "`<concept>` leaks across the seam."
- "Deepen: one interface, one place to test."
- "Two adapters justify the seam: `<production adapter>` and `<test adapter>`."

Wins name locality or leverage, never "cleaner" or "easier to maintain". No hedging. A sentence that could be a bullet is a bullet.

## Network

The two CDN scripts need a network connection when the report is viewed. When the user asks for an offline report, or the network is blocked: inline CSS in place of Tailwind, hand-built SVG in place of Mermaid, and no scripts.
