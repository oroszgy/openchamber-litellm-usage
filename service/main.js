// service/main.ts
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";

// service/config.ts
import { dirname, isAbsolute, join } from "node:path";

// service/jsonc.ts
function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}
function stripJsonc(text) {
  let out = "";
  let inString = false;
  for (let index = 0;index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== `
`)
        index += 1;
      out += `
`;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/"))
        index += 1;
      index += 1;
      continue;
    }
    out += char;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// service/config.ts
class ConfigReadError extends Error {
  path;
  constructor(path) {
    super(`The OpenCode config at ${path} is unreadable.`);
    this.path = path;
    this.name = "ConfigReadError";
  }
}
function managementRoot(baseURL) {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}
async function readCandidates(directory, deps) {
  const { env } = deps;
  const vars = env.vars ?? {};
  const configHome = env.xdgConfigHome ?? `${env.home}/.config`;
  const dataHome = env.xdgDataHome ?? `${env.home}/.local/share`;
  const configDir = vars.OPENCODE_CONFIG_DIR ?? `${configHome}/opencode`;
  const layers = [`${configDir}/opencode.jsonc`, `${configDir}/opencode.json`];
  if (directory) {
    layers.push(`${directory}/opencode.jsonc`, `${directory}/opencode.json`, `${directory}/.opencode/opencode.jsonc`, `${directory}/.opencode/opencode.json`);
  }
  const custom = vars.OPENCODE_CONFIG;
  if (custom) {
    layers.push(custom);
  } else {
    layers.push(`${env.home}/.config/openchamber/opencode.managed.jsonc`, `${env.home}/.config/openchamber/opencode.managed.json`);
  }
  const merged = {};
  for (const path of layers) {
    const text = await deps.readText(path);
    if (text === null)
      continue;
    let config;
    try {
      config = parseJsonc(text);
    } catch {
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
  const candidates = [];
  for (const [id, entry] of Object.entries(merged)) {
    const baseURL = entry.options?.baseURL;
    if (!baseURL)
      continue;
    candidates.push({
      id,
      name: entry.name ?? id,
      host: managementRoot(baseURL),
      key: entry.options?.apiKey ?? authKeys[id] ?? null
    });
  }
  return candidates;
}
function defaultProviderId(ids) {
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const score = editDistance(id.toLowerCase(), "litellm");
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}
async function resolveEntry(entry, baseDir, deps) {
  const baseURL = entry.options?.baseURL ?? entry.settings?.baseURL;
  const rawKey = entry.options?.apiKey ?? entry.settings?.apiKey;
  const apiKey = await resolveKey(rawKey, baseDir, deps);
  return {
    ...entry.name !== undefined ? { name: entry.name } : {},
    options: {
      ...baseURL !== undefined ? { baseURL } : {},
      ...apiKey !== null ? { apiKey } : {}
    }
  };
}
async function resolveKey(raw, baseDir, deps) {
  if (!raw)
    return null;
  const envRef = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
  if (envRef)
    return deps.env.vars?.[envRef[1]] ?? null;
  const fileRef = /^\{file:(.+)\}$/.exec(raw);
  if (fileRef) {
    const target = fileRef[1].trim();
    const path = target.startsWith("~/") ? join(deps.env.home, target.slice(2)) : isAbsolute(target) ? target : join(baseDir, target);
    const text = await deps.readText(path);
    return text === null ? null : text.trim();
  }
  return raw;
}
async function readAuthKeys(path, readText) {
  const text = await readText(path);
  if (text === null)
    return {};
  try {
    const data = JSON.parse(text);
    const keys = {};
    for (const [id, entry] of Object.entries(data)) {
      if (entry?.key)
        keys[id] = entry.key;
    }
    return keys;
  } catch {
    return {};
  }
}
function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const grid = Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_2, col) => row === 0 ? col : col === 0 ? row : 0));
  for (let row = 1;row < rows; row += 1) {
    for (let col = 1;col < cols; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      const above = grid[row - 1]?.[col] ?? 0;
      const left = grid[row]?.[col - 1] ?? 0;
      const diagonal = grid[row - 1]?.[col - 1] ?? 0;
      grid[row][col] = Math.min(above + 1, left + 1, diagonal + cost);
    }
  }
  return grid[a.length]?.[b.length] ?? 0;
}

// service/litellm.ts
import { createHash } from "node:crypto";
var PROBE_TIMEOUT_MS = 2000;
async function readKeyInfo(fetchImpl, target, timeoutMs = PROBE_TIMEOUT_MS) {
  let response;
  try {
    response = await fetchImpl(`${target.host}/key/info`, {
      headers: { authorization: `Bearer ${target.key}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    return { ok: false, code: "provider_unreachable" };
  }
  if (response.status === 401 || response.status === 403)
    return { ok: false, code: "unauthorized" };
  if (response.status === 404)
    return { ok: false, code: "unsupported_proxy" };
  if (!response.ok)
    return { ok: false, code: "upstream_error" };
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, code: "unsupported_proxy" };
  }
  const info = body?.info;
  const spend = numberAt(info, "spend");
  if (!info || spend === undefined)
    return { ok: false, code: "unsupported_proxy" };
  const userId = typeof info.user_id === "string" ? info.user_id : undefined;
  const budgets = readBudgets(info, spend);
  return {
    ok: true,
    spend,
    ...userId !== undefined ? { userId } : {},
    ...budgets !== undefined ? { budgets } : {}
  };
}
function readBudgets(info, spend) {
  const budgets = {};
  const legacyCap = numberAt(info, "max_budget");
  if (legacyCap !== undefined) {
    const duration = typeof info.budget_duration === "string" ? info.budget_duration.trim() : "";
    const period = duration.length > 0 ? periodFor(duration) : "total";
    if (period)
      keepTighter(budgets, period, { cap: legacyCap, spend });
  }
  const limits = info.budget_limits;
  const usage = info.budget_limits_usage;
  if (Array.isArray(limits) && usage !== null && typeof usage === "object") {
    const byDuration = usage;
    for (const entry of limits) {
      if (entry === null || typeof entry !== "object")
        continue;
      const record = entry;
      const rawDuration = typeof record.budget_duration === "string" ? record.budget_duration.trim() : "";
      const cap = numberAt(record, "max_budget");
      if (rawDuration.length === 0 || cap === undefined)
        continue;
      const period = periodFor(rawDuration);
      if (!period)
        continue;
      const usageEntry = byDuration[rawDuration] ?? byDuration[rawDuration.toLowerCase()];
      const windowSpend = numberAt(usageEntry, "current_spend");
      if (windowSpend === undefined)
        continue;
      keepTighter(budgets, period, { cap, spend: windowSpend });
    }
  }
  return Object.keys(budgets).length > 0 ? budgets : undefined;
}
function periodFor(duration) {
  switch (duration.toLowerCase()) {
    case "24h":
    case "1d":
    case "1day":
      return "day";
    case "7d":
    case "1w":
    case "1week":
      return "week";
    case "30d":
    case "1mo":
    case "1month":
      return "month";
    default:
      return null;
  }
}
function keepTighter(budgets, period, candidate) {
  const current = budgets[period];
  if (!current || ratio(candidate) > ratio(current))
    budgets[period] = candidate;
}
function ratio(window) {
  if (window.cap <= 0)
    return window.spend > 0 ? Number.POSITIVE_INFINITY : 0;
  return window.spend / window.cap;
}
async function readDailyActivity(fetchImpl, target, startDate, endDate, timezoneOffsetMinutes) {
  const apiKey = createHash("sha256").update(target.key).digest("hex");
  const buckets = [];
  for (let page = 1;page <= 4; page += 1) {
    const query = new URLSearchParams({
      api_key: apiKey,
      start_date: startDate,
      end_date: endDate,
      include_current_utc_day: "true",
      timezone: String(timezoneOffsetMinutes),
      page: String(page)
    });
    let response;
    try {
      response = await fetchImpl(`${target.host}/user/daily/activity?${query.toString()}`, {
        headers: { authorization: `Bearer ${target.key}` }
      });
    } catch {
      return null;
    }
    if (!response.ok)
      return null;
    let body;
    try {
      body = await response.json();
    } catch {
      return null;
    }
    const pageBody = body;
    const results = pageBody?.results;
    if (!Array.isArray(results))
      return null;
    for (const result of results) {
      const date = result.date;
      const spend = result.metrics?.spend;
      if (typeof date === "string" && typeof spend === "number") {
        buckets.push({ date, spend });
      }
    }
    if (pageBody?.metadata?.has_more !== true)
      break;
  }
  return buckets;
}
function numberAt(value, key) {
  if (value === null || typeof value !== "object")
    return;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

// service/discovery.ts
var PROBE_CACHE_MS = 60000;
function createDiscovery(deps) {
  const cache = new Map;
  const now = deps.now ?? Date.now;
  async function probe(candidate, at) {
    if (candidate.key === null)
      return { ok: false, code: "no_key" };
    const cacheKey = `${candidate.host}\x00${candidate.key}`;
    const cached = cache.get(cacheKey);
    if (cached && at - cached.at < PROBE_CACHE_MS)
      return cached.result;
    const result = await readKeyInfo(deps.fetch, { host: candidate.host, key: candidate.key });
    cache.set(cacheKey, { at, result });
    return result;
  }
  return async function discover(directory) {
    const candidates = await readCandidates(directory, deps);
    const at = now();
    const probed = await Promise.all(candidates.map(async (candidate) => ({ candidate, result: await probe(candidate, at) })));
    const confirmed = [];
    const unconfirmed = [];
    for (const { candidate, result } of probed) {
      if (result.ok && candidate.key !== null) {
        confirmed.push({
          id: candidate.id,
          name: candidate.name,
          host: candidate.host,
          key: candidate.key,
          info: result
        });
      } else {
        unconfirmed.push({
          id: candidate.id,
          name: candidate.name,
          host: candidate.host,
          code: result.ok ? "no_key" : result.code
        });
      }
    }
    return { confirmed, unconfirmed };
  };
}

// service/dates.ts
function offsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const part = (type) => Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  const wallClock = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return Math.round((date.getTime() - wallClock) / 60000);
}
function localDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "01";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
function shiftDate(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}
function bucketRolling(buckets, today) {
  const weekStart = shiftDate(today, -6);
  const monthStart = shiftDate(today, -29);
  let day = 0;
  let week = 0;
  let month = 0;
  for (const bucket of buckets) {
    if (bucket.date === today)
      day += bucket.spend;
    if (bucket.date >= weekStart && bucket.date <= today)
      week += bucket.spend;
    if (bucket.date >= monthStart && bucket.date <= today)
      month += bucket.spend;
  }
  return { day: round(day), week: round(week), month: round(month) };
}
function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

// service/app.ts
var ROLLING_UNAVAILABLE = "Rolling spend is unavailable for this key.";
var error = (status, code, message) => ({
  status,
  body: { error: { code, message } }
});
function createService(deps) {
  const discover = createDiscovery({
    readText: deps.readText,
    env: deps.env,
    fetch: deps.fetch,
    now: () => deps.now().getTime()
  });
  return (request, response) => {
    handle(deps, discover, request).then((answer) => send(response, answer)).catch((cause) => {
      console.error("[litellm-usage] unhandled service error:", cause);
      send(response, error(502, "upstream_error", "The service could not complete the request."));
    });
  };
}
async function handle(deps, discover, request) {
  if (request.headers.authorization !== `Bearer ${deps.token}`) {
    return error(401, "unauthorized", "Missing or invalid bearer token.");
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET")
    return error(404, "not_found", "Not found.");
  try {
    if (url.pathname === "/health")
      return { status: 200, body: { ok: true } };
    if (url.pathname === "/providers")
      return await listProviders(discover, url.searchParams.get("directory"));
    if (url.pathname === "/usage")
      return await usage(deps, discover, url);
  } catch (cause) {
    if (cause instanceof ConfigReadError) {
      return error(500, "config_read_error", "The OpenCode configuration could not be read.");
    }
    throw cause;
  }
  return error(404, "not_found", "Not found.");
}
async function listProviders(discover, directory) {
  const { confirmed } = await discover(directory);
  const body = {
    providers: confirmed.map(publicTarget),
    default: defaultProviderId(confirmed.map((target) => target.id))
  };
  return { status: 200, body };
}
async function usage(deps, discover, url) {
  const directory = url.searchParams.get("directory");
  const { confirmed } = await discover(directory);
  const requested = url.searchParams.get("provider") ?? defaultProviderId(confirmed.map((target2) => target2.id));
  const target = confirmed.find((candidate) => candidate.id === requested);
  if (!target)
    return error(404, "no_provider", `No LiteLLM provider matching '${requested ?? ""}'.`);
  const now = deps.now();
  const timeZone = deps.env.timeZone ?? "UTC";
  const today = localDate(now, timeZone);
  const body = {};
  if (target.info.budgets)
    body.budgets = target.info.budgets;
  if (!target.info.userId) {
    body.notice = ROLLING_UNAVAILABLE;
  } else {
    const buckets = await readDailyActivity(deps.fetch, target, shiftDate(today, -29), today, offsetMinutes(now, timeZone));
    if (buckets) {
      body.rolling = bucketRolling(buckets, today);
    } else {
      body.notice = ROLLING_UNAVAILABLE;
    }
  }
  return { status: 200, body };
}
function publicTarget(target) {
  return { id: target.id, name: target.name };
}
function send(response, answer) {
  response.writeHead(answer.status, { "content-type": "application/json" });
  response.end(JSON.stringify(answer.body));
}

// service/main.ts
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? "");
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!Number.isInteger(PORT) || PORT <= 0) {
  process.stderr.write(`OPENCHAMBER_SERVICE_PORT is missing or invalid
`);
  process.exit(1);
}
if (!TOKEN) {
  process.stderr.write(`OPENCHAMBER_SERVICE_TOKEN is missing
`);
  process.exit(1);
}
var server = createServer(createService({
  token: TOKEN,
  fetch,
  now: () => new Date,
  env: {
    home: homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgDataHome: process.env.XDG_DATA_HOME,
    vars: process.env,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  },
  readText: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  }
}));
server.listen(PORT, "127.0.0.1");
