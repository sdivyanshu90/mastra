import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { z } from 'zod/v3';
import { Agent } from './agent';

it('surfaces a rejected client-tool continuation without reconnecting the subscription', async () => {
  const runId = 'run-1';
  const chunks = [
    { type: 'tool-call', runId, payload: { toolCallId: 'call-1', toolName: 'local', args: {} } },
    { type: 'finish', runId, payload: { stepResult: { reason: 'tool-calls' } } },
  ];
  let approvals = 0;
  let subscriptions = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url?.endsWith('/signals')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, runId }));
    } else if (req.url?.endsWith('/threads/subscribe')) {
      subscriptions++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(subscriptions === 1 ? chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') : '');
    } else if (req.url?.endsWith('/send-tool-approval')) {
      approvals++;
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Continuation rejected' }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = (server.address() as AddressInfo).port;
    const agent = new Agent({ baseUrl: `http://127.0.0.1:${port}` }, 'test-agent');
    const scope = { threadId: 'thread-1', resourceId: 'resource-1' };
    await agent.sendSignal({
      ...scope,
      signal: { type: 'user-message', contents: 'hello' },
      ifIdle: {
        streamOptions: {
          clientTools: {
            local: {
              id: 'local',
              description: 'A local tool',
              inputSchema: z.object({}),
              execute: async () => ({ ok: true }),
            },
          },
        },
      },
    });
    const subscription = await agent.subscribeToThread(scope);
    await expect(
      subscription.processDataStream({
        onChunk: () => {},
        reconnect: { maxRetries: 1, delayMs: 0 },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(approvals).toBe(1);
    expect(subscriptions).toBe(1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
