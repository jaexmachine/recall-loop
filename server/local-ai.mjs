import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { handleAiRequest } from './ai-handler.mjs';

try {
  const envFile = await readFile(new URL('../.env', import.meta.url), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*(OPENAI_API_KEY|OPENAI_MODEL)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {
  // Environment variables can be supplied directly instead of using a local .env file.
}

const port = Number(process.env.AI_LOCAL_PORT || 3001);
const server = createServer(async (incoming, outgoing) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > 100_000) {
      outgoing.writeHead(413, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'That request is too large.' }));
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const request = new Request(`http://localhost:${port}${incoming.url || '/api/ai'}`, {
    method: incoming.method,
    headers,
    body: ['GET', 'HEAD'].includes(incoming.method || '') || !body.length ? undefined : body,
  });
  try {
    const response = await handleAiRequest(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'The local AI service could not handle that request.' }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Recall Loop AI endpoint listening at http://localhost:${port}/api/ai`);
});
