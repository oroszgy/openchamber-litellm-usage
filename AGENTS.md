# AGENTS.md

## What this repo is

`openchamber-litellm-usage` — an OpenChamber extension that adds a **LiteLLM
Usage** section to the chat's Work Status panel. It has no rail panel: the only
surface is a status section, backed by a local service that talks to a
self-hosted LiteLLM proxy.

## Repo map

- `status/` — the Work Status section frame (`index.html` + `main.ts` → built
  `main.js`). Runs only while the panel is shown and the section is expanded.
- `service/` — the local service (`main.ts` → built `main.js`). Binds loopback,
  holds the proxy key, calls LiteLLM, answers `GET /health`.
- `package.json` — the `openchamber` manifest block is the source of truth for
  the extension's id, section, and service.
- Built bundles (`status/main.js`, `service/main.js`) are committed so the repo
  installs directly from a URL; regenerate with `bun run build`.

## Agent skills

Skills come from <https://github.com/mattpocock/skills>. They are vendored into
`.agents/skills/` and pinned by `skills-lock.json` (both gitignored, since they
regenerate). Reinstall with:

```sh
npx skills@latest add mattpocock/skills
```

Run `/setup-matt-pocock-skills` once to record this repo's issue tracker and
domain-doc conventions below.
