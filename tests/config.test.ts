import { expect, test } from 'bun:test';
import {
  ConfigReadError,
  defaultProviderId,
  managementRoot,
  readCandidates,
  type ConfigDeps,
} from '../service/config';
import { parseJsonc } from '../service/jsonc';

const env = {
  home: '/home/test',
  xdgConfigHome: '/home/test/.config',
  xdgDataHome: '/home/test/.local/share',
  vars: {} as Record<string, string | undefined>,
};

function deps(files: Record<string, string>, overrides: Partial<typeof env> = {}): ConfigDeps {
  return { env: { ...env, ...overrides }, readText: async (path) => files[path] ?? null };
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

test('every provider with a base URL is a candidate, whatever its name', async () => {
  const files = {
    '/proj/opencode.json': JSON.stringify({
      provider: {
        openai: { name: 'OpenAI', options: { baseURL: 'https://api.openai.com/v1', apiKey: 'x' } },
        litelm: { name: 'Litelm', options: { baseURL: 'https://h/v1', apiKey: 'sk-test' } },
      },
    }),
  };
  const candidates = await readCandidates('/proj', deps(files));
  expect(candidates).toEqual([
    { id: 'openai', name: 'OpenAI', host: 'https://api.openai.com', key: 'x' },
    { id: 'litelm', name: 'Litelm', host: 'https://h', key: 'sk-test' },
  ]);
});

test('a provider with no base URL is not a candidate', async () => {
  const files = {
    '/proj/opencode.json': JSON.stringify({ provider: { anthropic: { name: 'Anthropic' } } }),
  };
  expect(await readCandidates('/proj', deps(files))).toEqual([]);
});

test('a provider with a base URL but no key is still a candidate, keyless', async () => {
  const files = {
    '/proj/opencode.json': JSON.stringify({
      provider: { litellm: { name: 'LiteLLM', options: { baseURL: 'https://h/v1' } } },
    }),
  };
  expect(await readCandidates('/proj', deps(files))).toEqual([
    { id: 'litellm', name: 'LiteLLM', host: 'https://h', key: null },
  ]);
});

test('the custom config wins over the project, which wins over the global', async () => {
  const files = {
    '/home/test/.config/openchamber/opencode.managed.json': JSON.stringify(provider('https://custom/v1')),
    '/home/test/.config/opencode/opencode.json': JSON.stringify(provider('https://global/v1')),
    '/proj/opencode.json': JSON.stringify(provider('https://proj/v1')),
  };
  const candidates = await readCandidates('/proj', deps(files));
  expect(candidates).toEqual([{ id: 'litellm', name: 'LiteLLM', host: 'https://custom', key: 'sk-test' }]);
});

test('.opencode/opencode.json beats the project root, and opencode.json beats .jsonc', async () => {
  const files = {
    '/proj/opencode.jsonc': JSON.stringify(provider('https://root-jsonc/v1')),
    '/proj/opencode.json': JSON.stringify(provider('https://root/v1')),
    '/proj/.opencode/opencode.json': JSON.stringify(provider('https://dot/v1')),
  };
  const candidates = await readCandidates('/proj', deps(files));
  expect(candidates).toEqual([{ id: 'litellm', name: 'LiteLLM', host: 'https://dot', key: 'sk-test' }]);
});

test('OPENCODE_CONFIG names the custom config, replacing the managed fallback', async () => {
  const files = {
    '/custom/opencode.json': JSON.stringify(provider('https://custom/v1')),
    '/proj/opencode.json': JSON.stringify(provider('https://proj/v1')),
  };
  const candidates = await readCandidates('/proj', deps(files, { vars: { OPENCODE_CONFIG: '/custom/opencode.json' } }));
  expect(candidates).toEqual([{ id: 'litellm', name: 'LiteLLM', host: 'https://custom', key: 'sk-test' }]);
});

test('OPENCODE_CONFIG_DIR moves the global config directory', async () => {
  const files = { '/alt/opencode/opencode.json': JSON.stringify(provider('https://alt/v1')) };
  const candidates = await readCandidates(null, deps(files, { vars: { OPENCODE_CONFIG_DIR: '/alt/opencode' } }));
  expect(candidates).toEqual([{ id: 'litellm', name: 'LiteLLM', host: 'https://alt', key: 'sk-test' }]);
});

test('the key falls back to OpenCode auth.json when the entry has none', async () => {
  const files = {
    '/proj/opencode.json': JSON.stringify({
      provider: { litellm: { name: 'LiteLLM', options: { baseURL: 'https://h/v1' } } },
    }),
    '/home/test/.local/share/opencode/auth.json': JSON.stringify({ litellm: { key: 'sk-auth' } }),
  };
  const candidates = await readCandidates('/proj', deps(files));
  expect(candidates).toEqual([{ id: 'litellm', name: 'LiteLLM', host: 'https://h', key: 'sk-auth' }]);
});

test('an {env:} key reference is resolved from the environment', async () => {
  const files = {
    '/proj/opencode.json': JSON.stringify({
      provider: { litellm: { options: { baseURL: 'https://h/v1', apiKey: '{env:LITELLM_KEY}' } } },
    }),
  };
  const candidates = await readCandidates('/proj', deps(files, { vars: { LITELLM_KEY: 'sk-env' } }));
  expect(candidates[0]?.key).toBe('sk-env');
});

test('an unset {env:} reference leaves the key unresolved', async () => {
  const files = {
    '/proj/opencode.json': JSON.stringify({
      provider: { litellm: { options: { baseURL: 'https://h/v1', apiKey: '{env:MISSING}' } } },
    }),
  };
  expect((await readCandidates('/proj', deps(files)))[0]?.key).toBeNull();
});

test('a {file:} key reference is read, relative to the config directory', async () => {
  const files = {
    '/proj/opencode.json': JSON.stringify({
      provider: { litellm: { options: { baseURL: 'https://h/v1', apiKey: '{file:./secret.key}' } } },
    }),
    '/proj/secret.key': 'sk-from-file\n',
  };
  expect((await readCandidates('/proj', deps(files)))[0]?.key).toBe('sk-from-file');
});

test('a ~/{file:} key reference is read from the home directory', async () => {
  const files = {
    '/proj/opencode.json': JSON.stringify({
      provider: { litellm: { options: { baseURL: 'https://h/v1', apiKey: '{file:~/keys/litellm}' } } },
    }),
    '/home/test/keys/litellm': 'sk-home',
  };
  expect((await readCandidates('/proj', deps(files)))[0]?.key).toBe('sk-home');
});

test('the v2 spelling (providers + settings) is understood', async () => {
  const files = {
    '/proj/opencode.json': JSON.stringify({
      providers: { litellm: { name: 'LiteLLM', settings: { baseURL: 'https://h/v1', apiKey: 'sk-v2' } } },
    }),
  };
  expect(await readCandidates('/proj', deps(files))).toEqual([
    { id: 'litellm', name: 'LiteLLM', host: 'https://h', key: 'sk-v2' },
  ]);
});

test('a present but unparseable config is a ConfigReadError, not "no providers"', async () => {
  const files = { '/proj/opencode.json': '{ this is not json' };
  expect(readCandidates('/proj', deps(files))).rejects.toBeInstanceOf(ConfigReadError);
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
