# Changelog

All notable, user-observable changes to this extension are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
version follows [Semantic Versioning](https://semver.org/) — minor for a feature,
patch for a fix. The bump and the entry land in the same commit as the change; see
the Versioning section of `AGENTS.md`.

## 0.3.0 — 2026-10-16

### Added

- Recognize the proxy by **probing** it (`GET /key/info`) instead of by name, so
  a provider added through OpenChamber's own UI is found wherever OpenCode keeps
  it — including `<project>/.opencode/` and the `$OPENCODE_CONFIG` file — and a
  typo in its id or name no longer hides a working proxy.
- List the candidates the probe **did not** confirm, each with the reason
  (`no key`, `rejected the key`, `did not answer /key/info`, `could not be
  reached`, `unexpected response`), in place of the bare "no provider" hint.
- Resolve `{env:NAME}` and `{file:path}` key references in a provider's
  `apiKey`, and honour `$OPENCODE_CONFIG_DIR`.

### Changed

- Read config layers in OpenCode's own precedence — `user < project <
  $OPENCODE_CONFIG` — so a managed or custom entry wins over the project, and a
  provider is read from `.opencode/opencode.json` as well as the project root.
- `/usage` re-uses the probe's read, so it makes one LiteLLM call on the happy
  path. The precise `unauthorized`, `unsupported_proxy` and `provider_unreachable`
  codes now describe an unconfirmed candidate on `/providers`; a proxy that is
  down reads as "no provider" plus the reason.

## 0.2.1 — 2026-10-12

### Fixed

- Stop the figures flickering while a session is active. The section now
  refreshes **in place** when the host reports a session or theme change — the
  current figures stay until the new ones arrive, a burst of host pushes
  collapses into a single request, and a failed refresh keeps the last figures
  rather than replacing them with an error.

## 0.2.0 — 2026-10-12

First public release.

- Show **rolling spend** — today, the last 7 days and the last 30 days, each a
  local calendar day — from the key's daily activity, always visible.
- Hide the key's spend figure behind a persisted **Show/Hide** toggle, revealed as
  **Lifetime spend** on an unbudgeted key and **Spend** when the key carries a
  budget window.
- Discover the proxy's URL and key from OpenCode's own provider config, with no
  credential form, and read it read-only.
- Report a present but unreadable OpenCode config as a fatal `config_read_error`
  rather than silently finding no provider.
- Match OpenChamber's default typography and theme tokens in the section.

## 0.1.0 — 2026-10-08

- Scaffold the extension: manifest (status section + local service), the Work
  Status frame, and the service loopback shell.
