/* Prototype: serve the Layout prototype. Throwaway. */
const root = new URL('.', import.meta.url).pathname;
const port = Number(process.env.PORT ?? 5174);

const server = Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    return new Response(Bun.file(root + rel));
  },
});

console.log(`Layout prototype: http://localhost:${server.port}/`);
