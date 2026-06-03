---
name: evolve-init
description: Interview the user to prepare an evolve.md for a fresh evolutionary code-optimization run. Covers Goal, Metric, Base, Gates, Termination, Inspiration, and an empty Ledger. Trigger when the user asks to set up, start, scaffold, or prepare an evolve experiment.
---

# evolve-init

You help the user write `evolve.md` for `@pi-dacmicu/evolve`. Both the orchestrator and every subagent read this file.

## Layout

The codebase to evolve lives in a `target/` subdirectory; `evolve.md` and the Ledger live in the parent. This keeps variant branches (created inside `target/`) cleanly separated from the experiment metadata.

If `target/` does not exist, ask the user to move/symlink/clone the codebase into it before continuing.

If `evolve.md` already exists, do not overwrite. Read it, summarize, ask whether to extend, replace, or abort.

## Interview

One section at a time. Confirm before moving on.

### 1. Name

Short kebab-case (e.g. `sort-throughput`). Used only in the `# Evolve:` header.

### 2. Goal

One paragraph: what the experiment is trying to achieve.

### 3. Metric

Primary metric: name, unit, direction (`lower` or `higher` is better). This is the score variants are ranked by and termination is checked against. Secondary metrics may be listed too if the user wants them observed alongside the primary.

### 4. Base

The git branch (inside `target/`) variants are forked from (e.g. `main`, `master`, `dev`). Used literally as `git checkout -b <branch> <base-ref>`.

### 5. Gates

Criteria a variant must satisfy before being scored. A Gate may be a shell command, an LLM judgment, a manual check — anything the subagent can evaluate. Write each Gate as a short, unambiguous instruction; the subagent follows the text literally. Order matters — cheapest/most likely to fail first.

### 6. Termination

When should the loop stop? Let the user phrase the conditions in their own words; record them verbatim. Suggestions you can offer if they're stuck:

- A hard cap on iterations (e.g. "stop after 30 Ledger rows").
- A target threshold on the primary metric (e.g. "stop when score <= 50 ms").
- A minimum number of iterations before any other condition fires (noise defense).
- A plateau rule (e.g. "stop if the top score hasn't improved in 10 iterations").

The orchestrator reads this section and judges it against the Ledger each iteration. `/evolve stop` and the `evolve` tool remain manual overrides.

### 7. Inspiration

Free-form notes: prior attempts, ideas to try, things to avoid, regions to focus on. Optional.

## Output

Write `evolve.md` in the parent of `target/`:

```markdown
# Evolve: <name>

## Goal

<Goal paragraph.>

## Metric

- Primary: <metric_name> (<unit>), <lower|higher> is better
- Secondary: <metric_name> (<unit>)   # optional, repeatable

## Base

<base-ref>

## Gates

- <gate 1>
- <gate 2>

## Termination

<Free-form list of stop conditions, in the user's words.>

## Inspiration

<Notes, or "(none)".>

## Ledger

| Branch | Parents | Score | Idea |
|--------|---------|-------|------|
```

**Branch naming convention:** each iteration creates a git branch inside `target/` named `dacmicu/evolve/vN/<slug>`, where `N` is the row's implicit ID (e.g. row #1 → `v1`, row #2 → `v2`). The version number must always match the row ID so the Ledger and branches stay aligned.

## After writing

Print the file path. Tell the user:

> evolve.md is ready. Run `/evolve` to start, or `/evolve <hint>` to bias the first iteration. Stop with `/evolve stop`.

Do not run `/evolve` yourself.
