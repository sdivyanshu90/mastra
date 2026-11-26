import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import type { WorkflowRunState } from '@mastra/core/workflows';
import { execa } from 'execa';
import getPort from 'get-port';
import { Inngest } from 'inngest';
import { afterAll, beforeAll, vi } from 'vitest';
import { z } from 'zod';
import { init } from '../index';
import { ensureInngestCliBinary } from './inngest-cli';

export function useWorkflowRunStatusFixture() {
  let baseUrl: string;
  let process: ReturnType<typeof execa> | undefined;

  beforeAll(async () => {
    const port = await getPort();
    baseUrl = `http://127.0.0.1:${port}`;
    process = execa(
      ensureInngestCliBinary(),
      [
        'dev',
        '--no-discovery',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--connect-gateway-port',
        String(await getPort()),
        '--connect-gateway-grpc-port',
        String(await getPort()),
        '--connect-executor-grpc-port',
        String(await getPort()),
      ],
      { reject: false },
    );
    await vi.waitFor(
      async () => {
        const response = await fetch(`${baseUrl}/dev`, { signal: AbortSignal.timeout(1000) });
        if (!response.ok) throw new Error('Inngest dev server is not ready');
      },
      { timeout: 15000, interval: 200 },
    );
  });

  afterAll(async () => {
    process?.kill();
    await process;
  });

  return async (status: WorkflowRunState['status']) => {
    const events: string[] = [];
    const inngest = new Inngest({
      id: 'workflow-status-test',
      isDev: true,
      baseUrl,
      fetch: async (input, requestInit) => {
        const response = await fetch(input, requestInit);
        if (response.ok && requestInit?.method === 'POST') {
          const sent = JSON.parse(String(requestInit.body)) as { name: string }[];
          events.push(...sent.map(event => event.name));
        }
        return response;
      },
    });
    const schema = z.object({ answer: z.number() });
    const { createWorkflow, createStep } = init(inngest);
    const step = createStep({
      id: 'approval',
      inputSchema: schema,
      outputSchema: schema,
      execute: async ({ inputData }) => inputData,
    });
    const workflow = createWorkflow({ id: 'order', inputSchema: schema, outputSchema: schema }).then(step).commit();
    const storage = new InMemoryStore();
    const mastra = new Mastra({ storage, workflows: { order: workflow } });
    const run = await mastra.getWorkflow('order').createRun();
    const workflows = (await storage.getStore('workflows'))!;
    const identity = { workflowName: 'order', runId: run.runId };
    const snapshot: WorkflowRunState = {
      runId: run.runId,
      status,
      result: status === 'success' ? { answer: 42 } : undefined,
      context: {},
      value: {},
      activePaths: [],
      activeStepsPath: {},
      serializedStepGraph: [],
      suspendedPaths: status === 'suspended' ? { approval: [0] } : {},
      resumeLabels: {},
      waitingPaths: {},
      timestamp: Date.now(),
    };
    await workflows.persistWorkflowSnapshot({ ...identity, snapshot });
    return { run, snapshot, events, load: () => workflows.loadWorkflowSnapshot(identity) };
  };
}
