// service/main.ts
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";

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
function managementRoot(baseURL) {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}
async function discoverProviders(directory, deps) {
  const configHome = deps.env.xdgConfigHome ?? `${deps.env.home}/.config`;
  const dataHome = deps.env.xdgDataHome ?? `${deps.env.home}/.local/share`;
  const sources = [];
  if (directory)
    sources.push([`${directory}/opencode.json`, `${directory}/opencode.jsonc`]);
  sources.push([`${configHome}/opencode/opencode.json`, `${configHome}/opencode/opencode.jsonc`]);
  sources.push([
    `${deps.env.home}/.config/openchamber/opencode.managed.json`,
    `${deps.env.home}/.config/openchamber/opencode.managed.jsonc`
  ]);
  const merged = {};
  for (const paths of [...sources].reverse()) {
    const config = await readFirst(paths, deps.readText);
    for (const [id, entry] of Object.entries(config.provider ?? {})) {
      const prior = merged[id];
      merged[id] = { ...prior, ...entry, options: { ...prior?.options, ...entry?.options } };
    }
  }
  const authKeys = await readAuthKeys(`${dataHome}/opencode/auth.json`, deps.readText);
  const providers = [];
  for (const [id, entry] of Object.entries(merged)) {
    const name = entry.name ?? id;
    if (!`${id} ${name}`.toLowerCase().includes("litellm"))
      continue;
    const baseURL = entry.options?.baseURL;
    const key = entry.options?.apiKey ?? authKeys[id];
    if (!baseURL || !key)
      continue;
    providers.push({ id, name, host: managementRoot(baseURL), key });
  }
  return providers;
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
async function readFirst(paths, readText) {
  for (const path of paths) {
    const text = await readText(path);
    if (text === null)
      continue;
    try {
      return parseJsonc(text);
    } catch {
      return {};
    }
  }
  return {};
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
async function readKeyInfo(fetchImpl, host, key) {
  let response;
  try {
    response = await fetchImpl(`${host}/key/info`, { headers: { authorization: `Bearer ${key}` } });
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
  if (!info || typeof info.spend !== "number")
    return { ok: false, code: "unsupported_proxy" };
  const userId = typeof info.user_id === "string" ? info.user_id : undefined;
  return { ok: true, spend: info.spend, userId };
}
async function readDailyActivity(fetchImpl, host, rawKey, startDate, endDate, timezoneOffsetMinutes) {
  const query = new URLSearchParams({
    api_key: createHash("sha256").update(rawKey).digest("hex"),
    start_date: startDate,
    end_date: endDate,
    include_current_utc_day: "true",
    timezone: String(timezoneOffsetMinutes)
  });
  let response;
  try {
    response = await fetchImpl(`${host}/user/daily/activity?${query.toString()}`, {
      headers: { authorization: `Bearer ${rawKey}` }
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
  const results = body?.results;
  if (!Array.isArray(results))
    return null;
  const buckets = [];
  for (const result of results) {
    const date = result.date;
    const spend = result.metrics?.spend;
    if (typeof date === "string" && typeof spend === "number")
      buckets.push({ date, spend });
  }
  return buckets;
}
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
var error = (status, code, message) => ({
  status,
  body: { error: { code, message } }
});
var MESSAGES = {
  unauthorized: "The LiteLLM key was rejected.",
  unsupported_proxy: "The proxy did not return a readable key.",
  provider_unreachable: "The LiteLLM proxy could not be reached.",
  upstream_error: "The LiteLLM proxy returned an unexpected response."
};
function createService(deps) {
  return (request, response) => {
    handle(deps, request).then((answer) => send(response, answer)).catch((cause) => send(response, error(502, "upstream_error", String(cause))));
  };
}
async function handle(deps, request) {
  if (request.headers.authorization !== `Bearer ${deps.token}`) {
    return error(401, "unauthorized", "Missing or invalid bearer token.");
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET")
    return error(404, "not_found", "Not found.");
  if (url.pathname === "/health")
    return { status: 200, body: { ok: true } };
  if (url.pathname === "/providers")
    return listProviders(deps, url.searchParams.get("directory"));
  if (url.pathname === "/usage")
    return usage(deps, url);
  return error(404, "not_found", "Not found.");
}
async function listProviders(deps, directory) {
  const providers = await discoverProviders(directory, deps);
  return {
    status: 200,
    body: {
      providers: providers.map(({ id, name, host }) => ({ id, name, host })),
      default: defaultProviderId(providers.map((provider) => provider.id))
    }
  };
}
async function usage(deps, url) {
  const directory = url.searchParams.get("directory");
  const providers = await discoverProviders(directory, deps);
  const requested = url.searchParams.get("provider") ?? defaultProviderId(providers.map((p) => p.id));
  const provider = providers.find((candidate) => candidate.id === requested);
  if (!provider)
    return error(404, "no_provider", `No LiteLLM provider matching '${requested ?? ""}'.`);
  const info = await readKeyInfo(deps.fetch, provider.host, provider.key);
  if (!info.ok)
    return error(502, info.code, MESSAGES[info.code]);
  const now = deps.now();
  const timeZone = deps.env.timeZone ?? "UTC";
  const today = localDate(now, timeZone);
  const body = {
    provider: publicProvider(provider),
    asOf: now.toISOString(),
    spend: info.spend
  };
  const rollingDegraded = {
    figure: "rolling",
    code: "rolling_unavailable",
    message: "Rolling spend is unavailable for this key."
  };
  if (!info.userId) {
    body.degraded = [rollingDegraded];
  } else {
    const buckets = await readDailyActivity(deps.fetch, provider.host, provider.key, shiftDate(today, -29), today, offsetMinutes(now, timeZone));
    if (buckets) {
      body.rolling = bucketRolling(buckets, today);
    } else {
      body.degraded = [rollingDegraded];
    }
  }
  return { status: 200, body };
}
function publicProvider(provider) {
  return { id: provider.id, name: provider.name, host: provider.host };
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
