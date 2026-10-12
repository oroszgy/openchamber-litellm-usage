import { expect, test } from 'bun:test';
import {
  ConfigReadError,
  defaultProviderId,
  discoverProviders,
  managementRoot,
  type ConfigDeps,
} from '../service/config';
import { parseJsonc } from '../service/jsonc';

const env = { home: '/home/test', xdgConfigHome: '/home/test/.config', xdgDataHome: '/home/test/.local/share' };

function deps(files: Record<string, string>): ConfigDeps {
  return { env, readText: async (path) => files[path] ?? null };
}

function provider(baseURL: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { provider: { litellm: { name: 'LiteLLM', options: { baseURL, apiKey: 'sk-test' }, ...extra } } };
}

test('managementRoot strips a trailing /v1 but keeps any prefix', () => {
  expect(managementRoot('https://h/v1')).toBe('https://h');
  expect(managementRoot('https://h/prefix/v1')).toBe('https://h/prefix');
  expect(managementRoot('https://h/v1/')).toBe('https://h');
  expect(managementRoot('https://h')).toBe('https://h');
});

test('defaultProviderId picks the candidate nearest "litellm"', () => {
  expect(defaultProviderId(['litellm', 'openrouter'])).toBe('litellm');
  expect(defaultProviderId(['my-litellm-proxy'])).toBe('my-litellm-proxy');
  expect(defaultProviderId([])).toBeNull();
});

test('a more specific source wins per provider id', async () => {
  const files = {
    '/home/test/.config/openchamber/opencode.managed.json': JSON.stringify(provider('https://managed/v1')),
    '/home/test/.config/opencode/opencode.json': JSON.stringify(provider('https://global/v1')),
    '/proj/opencode.json': JSON.stringify(provider('https://proj/v1')),
  };
  const providers = await discoverProviders('/proj', deps(files));
  expect(providers).toEqual([{ id: 'litellm', name: 'LiteLLM', host: 'https://proj', key: 'sk-test' }]);
});

test('a provider found only in the managed source still surfaces', async () => {
  const files = {
    '/home/test/.config/openchamber/opencode.managed.json': JSON.stringify(provider('https://managed/v1')),
  };
  const providers = await discoverProviders('/proj', deps(files));
  expect(providers).toEqual([{ id: 'litellm', name: 'LiteLLM', host: 'https://managed', key: 'sk-test' }]);
});

test('the key falls back to OpenCode auth.json when the entry has none', async () => {
  const files = {
    '/proj/opencode.json': JSON.stringify({
      provider: { litellm: { name: 'LiteLLM', options: { baseURL: 'https://h/v1' } } },
    }),
    '/home/test/.local/share/opencode/auth.json': JSON.stringify({ litellm: { key: 'sk-auth' } }),
  };
  const providers = await discoverProviders('/proj', deps(files));
  expect(providers).toEqual([{ id: 'litellm', name: 'LiteLLM', host: 'https://h', key: 'sk-auth' }]);
});

test('non-LiteLLM providers are ignored, and a JSONC config is understood', async () => {
  const files = {
    '/proj/opencode.jsonc': `{
      // a comment, and a trailing comma
      "provider": {
        "openai": { "options": { "baseURL": "https://api.openai.com/v1", "apiKey": "x" } },
        "litellm": { "name": "LiteLLM", "options": { "baseURL": "https://h/v1", "apiKey": "sk-test" } },
      },
    }`,
  };
  const providers = await discoverProviders('/proj', deps(files));
  expect(providers.map((p) => p.id)).toEqual(['litellm']);
});

test('a present but unparseable config is a ConfigReadError, not "no providers"', async () => {
  const files = { '/proj/opencode.json': '{ this is not json' };
  expect(discoverProviders('/proj', deps(files))).rejects.toBeInstanceOf(ConfigReadError);
});

test('parseJsonc strips line and block comments and trailing commas', () => {
  const source = `{
    // line
    "a": 1, /* block */
    "b": "// not a comment",
    "c": [1, 2,],
  }`;
  expect(parseJsonc(source)).toEqual({ a: 1, b: '// not a comment', c: [1, 2] });
  expect(() => parseJsonc('{ nope')).toThrow();
});
