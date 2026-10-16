/**
 * Candidate discovery: read OpenCode's own config, find the providers it names
 * with a base URL, and turn each into a management root plus the key to use
 * (if any). Whether a candidate really is LiteLLM is decided later, by the
 * probe in `discovery.ts` — the name is not trusted here.
 *
 * Sources, least specific first so a later one wins per provider id — matching
 * OpenCode's own merge order (user < project < `OPENCODE_CONFIG`):
 *
 * 1. global `<config-dir>/opencode.json(c)`, `$OPENCODE_CONFIG_DIR` else
 *    `$XDG_CONFIG_HOME/opencode`;
 * 2. the project's `opencode.json(c)` then `.opencode/opencode.json(c)`;
 * 3. the custom config `$OPENCODE_CONFIG`, else OpenChamber's managed
 *    `~/.config/openchamber/opencode.managed.json(c)`.
 *
 * A provider's key is its inline `options.apiKey` (or `settings.apiKey`), with
 * OpenCode's `{env:}`/`{file:}` references resolved, else `auth.json`'s
 * `<id>.key`.
 */
import { dirname, isAbsolute, join } from 'node:path';
import { parseJsonc } from './jsonc.ts';

/** A provider entry that names a base URL: it might be a LiteLLM proxy. */
export type Candidate = { id: string; name: string; host: string; key: string | null };

/** An OpenCode config file exists but cannot be read: a fatal, explicit state. */
export class ConfigReadError extends Error {
  constructor(readonly path: string) {
    super(`The OpenCode config at ${path} is unreadable.`);
    this.name = 'ConfigReadError';
  }
}

export type ConfigEnv = {
  home: string;
  xdgConfigHome?: string | undefined;
  xdgDataHome?: string | undefined;
  /** The process environment: `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG` and `{env:}` keys. */
  vars?: Record<string, string | undefined> | undefined;
};

export type ConfigDeps = {
  readText: (path: string) => Promise<string | null>;
  env: ConfigEnv;
};

type ProviderEntry = {
  name?: string;
  options?: { baseURL?: string; apiKey?: string };
  settings?: { baseURL?: string; apiKey?: string };
};
type RawConfig = {
  provider?: Record<string, ProviderEntry>;
  providers?: Record<string, ProviderEntry>;
};

/** The management root: the base URL with any trailing `/v1` removed. */
export function managementRoot(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
}

export async function readCandidates(directory: string | null, deps: ConfigDeps): Promise<Candidate[]> {
  const { env } = deps;
  const vars = env.vars ?? {};
  const configHome = env.xdgConfigHome ?? `${env.home}/.config`;
  const dataHome = env.xdgDataHome ?? `${env.home}/.local/share`;
  const configDir = vars.OPENCODE_CONFIG_DIR ?? `${configHome}/opencode`;

  const layers: string[] = [`${configDir}/opencode.jsonc`, `${configDir}/opencode.json`];
  if (directory) {
    layers.push(
      `${directory}/opencode.jsonc`,
      `${directory}/opencode.json`,
      `${directory}/.opencode/opencode.jsonc`,
      `${directory}/.opencode/opencode.json`,
    );
  }
  const custom = vars.OPENCODE_CONFIG;
  if (custom) {
    layers.push(custom);
  } else {
    layers.push(
      `${env.home}/.config/openchamber/opencode.managed.jsonc`,
      `${env.home}/.config/openchamber/opencode.managed.json`,
    );
  }

  const merged: Record<string, ProviderEntry> = {};
  for (const path of layers) {
    const text = await deps.readText(path);
    if (text === null) continue;
    let config: RawConfig;
    try {
      config = parseJsonc(text) as RawConfig;
    } catch {
      // Present but unparseable: never mistake it for "no providers configured".
      throw new ConfigReadError(path);
    }
    const entries = { ...config.provider, ...config.providers };
    const baseDir = dirname(path);
    for (const [id, entry] of Object.entries(entries)) {
      const resolved = await resolveEntry(entry, baseDir, deps);
      const prior = merged[id];
      merged[id] = { ...prior, ...resolved, options: { ...prior?.options, ...resolved.options } };
    }
  }

  const authKeys = await readAuthKeys(`${dataHome}/opencode/auth.json`, deps.readText);

  const candidates: Candidate[] = [];
  for (const [id, entry] of Object.entries(merged)) {
    const baseURL = entry.options?.baseURL;
    if (!baseURL) continue;
    candidates.push({
      id,
      name: entry.name ?? id,
      host: managementRoot(baseURL),
      key: entry.options?.apiKey ?? authKeys[id] ?? null,
    });
  }
  return candidates;
}

/** The candidate whose id is closest to `litellm`, or `null` when there are none. */
export function defaultProviderId(ids: string[]): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const score = editDistance(id.toLowerCase(), 'litellm');
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/** Flatten an entry's v1 (`options`) and v2 (`settings`) spellings, resolving its key. */
async function resolveEntry(entry: ProviderEntry, baseDir: string, deps: ConfigDeps): Promise<ProviderEntry> {
  const baseURL = entry.options?.baseURL ?? entry.settings?.baseURL;
  const rawKey = entry.options?.apiKey ?? entry.settings?.apiKey;
  const apiKey = await resolveKey(rawKey, baseDir, deps);
  return {
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    options: {
      ...(baseURL !== undefined ? { baseURL } : {}),
      ...(apiKey !== null ? { apiKey } : {}),
    },
  };
}

/**
 * Resolve an `apiKey` in OpenCode's own substitutions: `{env:NAME}` from the
 * environment, `{file:path}` from a file (`~/` is home, a relative path the
 * config file's directory). Anything else is the literal key; `null` when the
 * reference cannot be resolved.
 */
async function resolveKey(raw: string | undefined, baseDir: string, deps: ConfigDeps): Promise<string | null> {
  if (!raw) return null;

  const envRef = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
  if (envRef) return deps.env.vars?.[envRef[1]!] ?? null;

  const fileRef = /^\{file:(.+)\}$/.exec(raw);
  if (fileRef) {
    const target = fileRef[1]!.trim();
    const path = target.startsWith('~/')
      ? join(deps.env.home, target.slice(2))
      : isAbsolute(target)
        ? target
        : join(baseDir, target);
    const text = await deps.readText(path);
    return text === null ? null : text.trim();
  }

  return raw;
}

async function readAuthKeys(
  path: string,
  readText: (path: string) => Promise<string | null>,
): Promise<Record<string, string>> {
  const text = await readText(path);
  if (text === null) return {};
  try {
    const data = JSON.parse(text) as Record<string, { key?: string }>;
    const keys: Record<string, string> = {};
    for (const [id, entry] of Object.entries(data)) {
      if (entry?.key) keys[id] = entry.key;
    }
    return keys;
  } catch {
    return {};
  }
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const grid: number[][] = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, col) => (row === 0 ? col : col === 0 ? row : 0)),
  );

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      const above = grid[row - 1]?.[col] ?? 0;
      const left = grid[row]?.[col - 1] ?? 0;
      const diagonal = grid[row - 1]?.[col - 1] ?? 0;
      grid[row]![col] = Math.min(above + 1, left + 1, diagonal + cost);
    }
  }

  return grid[a.length]?.[b.length] ?? 0;
}
