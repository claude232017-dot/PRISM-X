# Skills Library

Vendored skill collections. Folders here are **inert** — Claude Code only loads
skills from `.claude/skills/`. To activate one, copy its folder up:

```bash
cp -r .claude/skills-library/ecc/skills/<name> .claude/skills/
```

## Contents

- **`ecc/`** — the complete skill collection from
  [affaan-m/ECC](https://github.com/affaan-m/ECC) ("Everything Claude Code"),
  vendored from its official npm distribution `ecc-universal@2.0.0` (MIT).
  All 197 skills are here; seven are pre-activated in `.claude/skills/`:
  `frontend-patterns`, `coding-standards`, `tdd-workflow`, `content-engine`,
  `brand-voice`, `crosspost`, `x-api` — the set most relevant to building and
  operating PRISM-X. Activating all 197 at once is not recommended: every
  active skill's description is loaded into each session's context.

## Also installed (directly in `.claude/skills/`)

- **`karpathy-guidelines`** — from
  [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) (MIT).
- **`ui-ux-pro-max`** + companions (`design`, `design-system`, `ui-styling`,
  `brand`, `banner-design`, `slides`) — from
  [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill),
  installed via its official `ui-ux-pro-max-cli@2.11.0` npm package (MIT).
