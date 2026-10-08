/**
 * The local service's loopback shell.
 *
 * It reads the host-issued port and bearer, binds `127.0.0.1`, and requires the
 * bearer on every request including health. Route logic and the LiteLLM calls
 * live behind this file.
 *
 * Contract: `@openchamber/sdk/GUEST_SERVICES.md`.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? '');
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';

if (!Number.isInteger(PORT) || PORT <= 0) {
  process.stderr.write('OPENCHAMBER_SERVICE_PORT is missing or invalid\n');
  process.exit(1);
}

type Answer = { status: number; body: unknown };

const send = (response: import('node:http').ServerResponse, answer: Answer): void => {
  response.writeHead(answer.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(answer.body));
};

const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    send(response, { status: 401, body: { error: 'Unauthorized' } });
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    send(response, { status: 200, body: { ok: true } });
    return;
  }
  // TODO: routes that read LiteLLM usage for the panel.
  send(response, { status: 404, body: { error: 'Not found' } });
});

server.listen(PORT, '127.0.0.1');
