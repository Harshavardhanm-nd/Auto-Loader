# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary of domain terms.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.
- **`CLAUDE.md`** at the repo root is not a domain doc, but it is the standing account of how this
  app behaves and which of its guards are currently off. Read it first regardless.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo is **single-context**: one `CONTEXT.md` and one `docs/adr/` at the root.

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-salesforce-is-read-only.md
│   └── 0002-byte-contracts-are-per-template.md
└── server/ web/ templates/ config/
```

Neither file exists yet — that is expected, and they get written when a term or a decision actually
needs pinning down, not upfront.

If this repo is ever split into packages, the multi-context layout is a root `CONTEXT-MAP.md`
pointing at one `CONTEXT.md` per context, with context-scoped ADRs under
`src/<context>/docs/adr/` alongside the system-wide `docs/adr/`. Nothing here assumes that today.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
