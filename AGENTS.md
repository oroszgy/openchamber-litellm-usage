# AGENTS.md

## What this repo is

`openchamber-litellm-usage` — an OpenChamber extension that adds a **LiteLLM
Usage** section to the chat's Work Status panel. It has no rail panel: the only
surface is a status section, backed by a local service that talks to a
self-hosted LiteLLM proxy. The `contributes.panel` block in `package.json` is the
manifest's required identity block (id, name, icon); it carries no `entry`, so no
rail page appears.

## Repo map

- `status/` — the Work Status section frame (`index.html` + `main.ts` → built
  `main.js`). Runs only while the panel is shown and the section is expanded.
  `view-model.ts` is the pure, DOM-free layer the tests drive.
- `service/` — the local service (`main.ts` → built `main.js`). `main.ts` is the
  thin loopback bootstrap; `app.ts` is `createService(deps)`, the seam the tests
  use. `config.ts` discovers providers, `litellm.ts` makes the LiteLLM calls,
  `dates.ts` is the pure calendar maths, `jsonc.ts` parses OpenCode's config.
- `shared/wire.ts` — the types-only wire contract both sides import with
  `import type`, so the bundler erases it from both bundles.
- `docs/adr/` — accepted decisions; `GLOSSARY.md` — domain vocabulary;
  `docs/images/` — README screenshots.
- `CODING_STANDARDS.md` — the review-time conventions (read before reviewing).
- `package.json` — the `openchamber` manifest block is the source of truth for the
  extension's id, section, service and required capabilities.
- **Built bundles** (`status/main.js`, `service/main.js`) are committed so the repo
  installs directly from a URL. Regenerate with `bun run build`; never hand-edit
  them, and never commit a source change without them. CI's `check:bundles` fails
  on drift.
- **Before committing** — `bun run check` (typecheck + build + tests).

## Versioning

A user-observable change gets a version bump and a `CHANGELOG.md` entry, landed in
one **release commit** on its feature branch, e.g.
`release: 0.2.0 — spend and rolling windows`. Bump the minor for a feature, the
patch for a fix: OpenChamber reloads an extension when its `version` changes, so
the bump is what makes a new manifest take effect. The release commit must carry
regenerated bundles. Docs- and chore-only changes leave the version alone.

## Agent skills

Skills come from <https://github.com/mattpocock/skills>. They are vendored into
`.agents/skills/` and pinned by `skills-lock.json` (both gitignored, since they
regenerate). Reinstall with:

```sh
npx skills@latest add mattpocock/skills
```

### Issue tracker

Issues and specs live as GitHub issues in `oroszgy/openchamber-litellm-usage`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, label string equal to name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
