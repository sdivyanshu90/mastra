import { describe, expect, it } from 'vitest';
import { processA2AStream } from './process-a2a-stream';

describe('A2A stream continuity', () => {
  it.each([': keep-alive', 'event: ping\nid: 3\nretry: 1000', 'data:', ''])(
    'preserves events after heartbeat %j',
    async heartbeat => {
      const first = { kind: 'status-update', taskId: 'task', status: { state: 'working' } };
      const last = { kind: 'artifact-update', taskId: 'task', artifact: { artifactId: 'answer' } };
      const text = `data: ${JSON.stringify({ result: first })}\n\n${heartbeat}\n\ndata: ${JSON.stringify({ result: last })}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
      const events = [];
      for await (const event of processA2AStream(stream)) events.push(event);
      expect(events).toEqual([first, last]);
    },
  );
  it('retains JSON record streams and the DONE sentinel', async () => {
    const text = '{"result":{"kind":"task","id":"a"}}\u001edata: [DONE]\n\ndata: {"id":"ignored"}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    const events = [];
    for await (const event of processA2AStream(stream)) events.push(event);
    expect(events).toEqual([{ kind: 'task', id: 'a' }]);
  });
});
