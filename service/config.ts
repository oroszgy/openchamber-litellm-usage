/**
 * Provider discovery: read OpenCode's own config, find the LiteLLM providers it
 * names, and turn each into a management root plus the virtual key to use.
 *
 * Sources, least specific first so a more specific source wins per provider id:
 * managed, then global, then the open project's `<directory>/opencode.json(c)`.
 * A provider's key is its inline `options.apiKey`, else `auth.json`'s `<id>.key`.
 */
import { parseJsonc } from './jsonc.ts';

export type Provider = { id: string; name: string; host: string; key: string };

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
};

export type ConfigDeps = {
  readText: (path: string) => Promise<string | null>;
  env: ConfigEnv;
};

type ProviderEntry = { name?: string; options?: { baseURL?: string; apiKey?: string } };
type RawConfig = { provider?: Record<string, ProviderEntry> };

/** The management root: the base URL with any trailing `/v1` removed. */
export function managementRoot(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
}

export async function discoverProviders(directory: string | null, deps: ConfigDeps): Promise<Provider[]> {
  const configHome = deps.env.xdgConfigHome ?? `${deps.env.home}/.config`;
  const dataHome = deps.env.xdgDataHome ?? `${deps.env.home}/.local/share`;

  const sources: string[][] = [];
  if (directory) sources.push([`${directory}/opencode.json`, `${directory}/opencode.jsonc`]);
  sources.push([`${configHome}/opencode/opencode.json`, `${configHome}/opencode/opencode.jsonc`]);
  sources.push([
    `${deps.env.home}/.config/openchamber/opencode.managed.json`,
    `${deps.env.home}/.config/openchamber/opencode.managed.jsonc`,
  ]);

  const merged: Record<string, ProviderEntry> = {};
  for (const paths of [...sources].reverse()) {
    const config = await readFirst(paths, deps.readText);
    for (const [id, entry] of Object.entries(config.provider ?? {})) {
      const prior = merged[id];
      merged[id] = { ...prior, ...entry, options: { ...prior?.options, ...entry?.options } };
    }
  }

  const authKeys = await readAuthKeys(`${dataHome}/opencode/auth.json`, deps.readText);

  const providers: Provider[] = [];
  for (const [id, entry] of Object.entries(merged)) {
    const name = entry.name ?? id;
    if (!`${id} ${name}`.toLowerCase().includes('litellm')) continue;
    const baseURL = entry.options?.baseURL;
    const key = entry.options?.apiKey ?? authKeys[id];
    if (!baseURL || !key) continue;
    providers.push({ id, name, host: managementRoot(baseURL), key });
  }
  return providers;
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

async function readFirst(
  paths: string[],
  readText: (path: string) => Promise<string | null>,
): Promise<RawConfig> {
  for (const path of paths) {
    const text = await readText(path);
    if (text === null) continue;
    try {
      return parseJsonc(text) as RawConfig;
    } catch {
      // Present but unparseable: never mistake it for "no providers configured".
      throw new ConfigReadError(path);
    }
  }
  return {};
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
