import { once } from 'node:events';
import { createServer } from 'node:http';
import { createOpenAI } from '@ai-sdk/openai';
import { RequestContext } from '@mastra/core/request-context';
import { LibSQLVector } from '@mastra/libsql';
import { expect, it } from 'vitest';
import { createGraphRAGTool } from './graph-rag';

it('uses the current request index instead of returning a previous index document', async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [1, 0, 0] }],
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const store = new LibSQLVector({ id: 'request-isolation', url: ':memory:' });
  try {
    for (const indexName of ['tenant_a', 'tenant_b']) {
      await store.createIndex({ indexName, dimension: 3 });
      await store.upsert({ indexName, vectors: [[1, 0, 0]], metadata: [{ text: indexName }], ids: [indexName] });
    }
    const address = server.address() as { port: number };
    const model = createOpenAI({ apiKey: 'test', baseURL: `http://127.0.0.1:${address.port}/v1` }).embedding(
      'text-embedding-3-small',
    );
    const tool = createGraphRAGTool({
      vectorStore: store,
      indexName: 'tenant_a',
      model,
      graphOptions: { dimension: 3 },
    });
    const run = async (indexName: string) => {
      const requestContext = new RequestContext();
      requestContext.set('indexName', indexName);
      return tool.execute({ queryText: 'document', topK: 1 }, { requestContext });
    };
    expect((await run('tenant_a')).relevantContext).toEqual(['tenant_a']);
    expect((await run('tenant_b')).relevantContext).toEqual(['tenant_b']);
    const concurrent = await Promise.all([run('tenant_a'), run('tenant_b')]);
    expect(concurrent.map(result => result.relevantContext)).toEqual([['tenant_a'], ['tenant_b']]);
  } finally {
    await store.close();
    server.close();
    await once(server, 'close');
  }
});
