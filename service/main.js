// service/main.ts
import { createServer } from "node:http";
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? "");
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!Number.isInteger(PORT) || PORT <= 0) {
  process.stderr.write(`OPENCHAMBER_SERVICE_PORT is missing or invalid
`);
  process.exit(1);
}
var send = (response, answer) => {
  response.writeHead(answer.status, { "content-type": "application/json" });
  response.end(JSON.stringify(answer.body));
};
var server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    send(response, { status: 401, body: { error: "Unauthorized" } });
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    send(response, { status: 200, body: { ok: true } });
    return;
  }
  send(response, { status: 404, body: { error: "Not found" } });
});
server.listen(PORT, "127.0.0.1");
