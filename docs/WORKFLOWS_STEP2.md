# Phase 11, step W2: The workflow builder

Branch `workflows/w2-builder`. Plan: `docs/WORKFLOWS_PLAN.md`. Behind `workflows_v1`, off by default and on for the local relay. Next: W3, customer-facing steps and simulation.

## What it does

**A Workflows area** in the icon strip, for teammates who manage the workspace, at `#workflows` (one workflow at `#workflows/<id>`). Settings › Inbox links to it.

**The list:**
- **Grouped by trigger,** as Intercom's is. Each group says what fires it and which workflows run: for customer triggers, only the highest-priority customer-facing match (and every background one); otherwise every match, in order.
- **Reordering:** drag a row, or use its arrows (for the keyboard). Reordering needs the whole trigger on screen, so it's off while a filter or search hides rows.
- **Each row shows:**
  - its priority and state (draft, live, paused)
  - its published version, and whether there are unpublished changes
  - who updated it and when
  - completed, failed and skipped runs in the last 30 days
- **The side menu** filters by state (all, live, drafts, paused) with counts, and there's a search.
- **New workflow:** a name and a trigger, then it opens in the builder.

**The builder:** a canvas (React Flow, `@xyflow/react` 12.12.0, MIT) of the trigger card and a card per lettered path.
- **Path cards:** each lists its steps in words ("Add the tag “Refund”", "Assign to the team Billing"). Its ways on sit at the right edge, each with a handle: Then, each branch, Else, When it holds, If it times out. A path that ends shows END.
- **Connecting:**
  - Drag from a handle to another card to connect that way on.
  - Drop on empty canvas to make a new path there, already connected.
  - Connecting the trigger to a path makes it the start.
  - Select a line and press Delete to disconnect it.
- **Moving:** drag cards; positions are kept with the workflow, not its versions, so moving cards is never an unpublished change.
- **Zoom bar:** zoom in and out, fit to screen, Tidy up (columns by distance from the trigger), add a path, and **List of paths** (Intercom's), which jumps to any path from the keyboard.
- **Undo and redo:** ⌘Z and ⇧⌘Z (Ctrl on Windows) or the buttons, for every change, including moves and tidying. Typing into one field counts as one step. Fields keep their own undo.
- **The panel** edits what's selected:
  - **The trigger:** what starts it (later triggers are listed, disabled, with when they arrive), its tag or attribute, what fires it.
  - **Who it runs for:** nested all/any groups, at most three deep, with pickers for tags, teams, teammates, brands and attributes.
  - **A path:** its name and steps (add, edit, move, remove), then what happens next: end, go to a path, branch on conditions (first match wins, else), or wait until a condition holds (for at most a duration). Every target can be a new path.
- **The live estimate:** as who it runs for changes, how many of the workspace's latest conversations (at most 500, from the last 30 days) it would have let through. For example: "It would have run for 21 of the last 50 conversations (42%)".
  - It's judged by the engine's own `evaluate` on the same facts a run sees.
  - What depends on the moment a run starts can't be judged after the fact: the triggering message, office hours, a team's availability, who made the change, a wait. Those conditions are taken to hold and named, so the figure becomes "at most".
  - Unfinished conditions say so instead of guessing.
- **Publishing is blocked with clear messages:**
  - The draft is checked as you edit, with the engine's own `validate` and `problems`.
  - Each problem is listed over the canvas (a path's problem selects its card) and the card is flagged. Publish stays disabled until none are left.
  - What only the server knows (a tag archived meanwhile, a team removed) comes back as the refusal's message, and nothing goes live.
- **Saving:**
  - Save draft keeps unfinished work. Publish saves first.
  - If someone else saved in between, the save is refused and Reload shows their version.
  - Leaving with unsaved changes asks first.
- **Versions:** every publish, by whom and when, and what it was restored from. Restore (with a confirmation) publishes an older version again as the next one; runs already going finish on theirs.
- **Pause, resume and archive** are in the bar.

## How it works

**Migration `0059_workflow_builder`:**
- `workflows.layout` (jsonb): `{trigger: {x,y}, A: {x,y}, …}`.
- **The rollback** clears layouts (the builder tidies any workflow without them). Nothing else needs turning off: the previous version ignores the column.

**Code:**
- **`lib/workflow-definition.ts`:**
  - `outlets(path)`: a path's ways on, with handle ids. `problems` now uses it.
  - `checkLayout`: known cards only, finite and rounded, kept within ±100,000.
  - `autoLayout` and `nextLetter`.
- **`server/workflows.ts`:**
  - `create` and `save` take `layout`. A save without one keeps the old positions for cards that still exist.
  - `readWorkflow` returns the layout and the pickers' options: active tags, teams, teammates, brands, conversation attributes, SLA policies, ticket types.
- **`server/workflow-estimate.ts`:** `estimateWorkflow` reads the sample in one query and judges each conversation with `evaluate`.
- **`server/workflow-engine.ts`:**
  - Facts are built by `buildFacts` from `FactSources`, shared by runs and the estimate.
  - `evaluate` takes the fields to assume.
- **`agent/workflows.tsx`:** the area and the list.
- **`agent/workflow-builder.tsx`:** the canvas, panel, history, versions. It's lazily loaded, so React Flow loads only when a workflow opens.
- **`agent/workflow-parts.tsx`:** condition and step editors, and the words cards use.
- **Canvas state:**
  - Cards and lines are derived from the draft on every render.
  - Only React Flow's measurements, a card mid-drag, and the selected lines are kept beside it.
  - Colours come from `agent/inbox.css` tokens, including React Flow's `--xy-*` variables, in both themes.
- **`components/relay/postgres-inbox.tsx`:** the area, its address, and the strip entry (`capabilities.workflows`: the flag and `workspace.manage`).
- **Settings:** `server/settings.ts` lists the `workflows` link card.
- **Route:** `GET workflow-estimate?when=<group as JSON>`, in the bridge allowlists. The estimate takes about 48 ms over 500 conversations on PGlite (median of 10), within the 200 ms request budget.
- **Seed:** the local dev relay creates a draft, "Example: route refund requests" (demo workspace, `exampleWorkflow`), once.

## Not included

These come later:
- **Customer-facing steps, reply buttons with branches, collecting replies, simulation against a real conversation:** W3. The exclusivity rule therefore still has nothing to exclude.
- **Run log pages, the failing alert, templates, the remaining triggers, sub-workflows:** W4. Run counts on the list are its only view of runs for now.
- **Intercom's Overview and Path Analysis views,** with sent, engaged and completed per path: they need W3's customer-facing steps to mean anything, and come with W4's run log.
- **Viewing an older version on the canvas before restoring it** isn't in the plan. Restore shows the version's number, author and date, and asks first.

## Checks

- **`tests/workflow-builder.test.ts`:**
  - **Pure:** outlets per kind of way on; Tidy up's columns, including an unreachable path; positions checked and clamped; letters past Z.
  - **Through the API:**
    - off by default (no area, Settings link or estimate), managers only
    - created and saved with positions; a save without them keeps those of cards that remain
    - moving cards isn't an unpublished change, and positions never enter versions
    - the pickers' options, with archived tags left out; another workspace can't read it
    - **the estimate:** by language, tag and nested any/all; moment-dependent conditions assumed and named; merged and older-than-30-days conversations left out; unfinished, unreadable and later-phase conditions refused in words; another workspace sees only its own
    - the rollback
- **`tests/browser/workflow-builder.spec.ts`** (ports 9030 and 9031):
  - **Happy path:**
    - New workflow from the list; a condition with its live estimate; a step on path A; path B made by dropping a way on onto empty canvas, then given a step.
    - Undo (⌘Z and the button) and redo (the button and ⇧⌘Z); the list of paths; Tidy up; a card dragged to a new place.
    - Publish shows version 1 live, with positions saved. A French customer's first message is tagged and routed by it.
    - Back in the list, a second workflow dragged above it and moved back with the arrows; the row shows Live and one completed run.
  - **Failure path:**
    - A branch with no target or condition: listed, flagged and Publish disabled, until undone.
    - A tag archived meanwhile: the server's refusal shown, nothing published.
    - Someone else's save: refused, then Reload shows theirs.
