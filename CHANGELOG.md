# Changelog

All notable, user-observable changes to this extension are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
version follows [Semantic Versioning](https://semver.org/) — minor for a feature,
patch for a fix. The bump and the entry land in the same commit as the change; see
the Versioning section of `AGENTS.md`.

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
