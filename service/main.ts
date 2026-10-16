/**
 * The local service's loopback shell.
 *
 * It reads the host-issued port and bearer, binds `127.0.0.1`, and hands every
 * request to `createService`. Route logic and the LiteLLM calls live in
 * `app.ts`; this file is only the process bootstrap.
 *
 * Contract: `@openchamber/sdk/GUEST_SERVICES.md`.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { createService } from './app.ts';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? '');
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';

if (!Number.isInteger(PORT) || PORT <= 0) {
  process.stderr.write('OPENCHAMBER_SERVICE_PORT is missing or invalid\n');
  process.exit(1);
}
if (!TOKEN) {
  process.stderr.write('OPENCHAMBER_SERVICE_TOKEN is missing\n');
  process.exit(1);
}

const server = createServer(
  createService({
    token: TOKEN,
    fetch,
    now: () => new Date(),
    env: {
      home: homedir(),
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      xdgDataHome: process.env.XDG_DATA_HOME,
      vars: process.env,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    readText: async (path) => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
  }),
);

server.listen(PORT, '127.0.0.1');
