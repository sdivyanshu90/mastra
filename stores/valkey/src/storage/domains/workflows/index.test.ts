import { randomUUID } from 'node:crypto';
import { TABLE_WORKFLOW_SNAPSHOT } from '@mastra/core/storage';
import type { WorkflowsStorage } from '@mastra/core/storage';
import type { WorkflowRunState } from '@mastra/core/workflows';
import { GlideClient } from '@valkey/valkey-glide';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ValkeyStore } from '../../store';
import { getKey } from '../utils';

const snapshot = (runId: string): WorkflowRunState => ({
  runId,
  status: 'suspended',
  value: {},
  context: {},
  activePaths: [],
  activeStepsPath: {},
  serializedStepGraph: [],
  suspendedPaths: {},
  resumeLabels: {},
  waitingPaths: {},
  requestContext: {},
  timestamp: Date.now(),
});

describe('WorkflowsValkey resource snapshots', () => {
  let client: GlideClient;
  let store: WorkflowsStorage;
  let runId: string;
  const workflowName = 'resource-snapshots';
  const resourceId = 'customer';
  const keys = () => ({ namespace: 'workflows', workflow_name: workflowName, run_id: runId });
  const canonicalKey = () => getKey(TABLE_WORKFLOW_SNAPSHOT, keys());
  const legacyKey = () => getKey(TABLE_WORKFLOW_SNAPSHOT, { ...keys(), resourceId });

  beforeAll(async () => {
    client = await GlideClient.createClient({
      addresses: [{ host: 'localhost', port: 6382 }],
      credentials: { password: 'valkey_password' },
    });
    const valkey = new ValkeyStore({ id: 'valkey-resource-snapshots', client });
    store = (await valkey.getStore('workflows'))!;
  });

  beforeEach(() => {
    runId = randomUUID();
  });

  afterEach(async () => {
    await client.del([canonicalKey(), legacyKey()]);
  });

  afterAll(() => client?.close());

  it('loads and updates a resource snapshot through the run identity', async () => {
    await store.persistWorkflowSnapshot({ workflowName, runId, resourceId, snapshot: snapshot(runId) });
    expect(await store.loadWorkflowSnapshot({ workflowName, runId })).toMatchObject({ status: 'suspended' });

    await store.updateWorkflowState({ workflowName, runId, opts: { status: 'running' } });
    await store.updateWorkflowResults({
      workflowName,
      runId,
      stepId: 'step',
      result: { status: 'success', output: 1 },
      requestContext: {},
    });

    expect(await store.loadWorkflowSnapshot({ workflowName, runId })).toMatchObject({
      status: 'running',
      context: { step: { status: 'success', output: 1 } },
    });
    expect(await store.getWorkflowRunById({ workflowName, runId })).toMatchObject({ resourceId });
    expect(await store.getWorkflowRunById({ runId })).toMatchObject({ resourceId });
    expect((await store.listWorkflowRuns({ workflowName, resourceId })).runs).toMatchObject([{ runId, resourceId }]);
    expect(await client.get(legacyKey())).toBeNull();

    await store.deleteWorkflowRunById({ workflowName, runId });
    expect(await store.loadWorkflowSnapshot({ workflowName, runId })).toBeNull();
  });

  it('loads legacy resource snapshots and preserves their metadata during updates', async () => {
    const createdAt = new Date('2025-01-01T00:00:00Z');
    await client.set(
      legacyKey(),
      JSON.stringify({ ...keys(), resourceId, snapshot: snapshot(runId), createdAt, updatedAt: createdAt }),
    );

    const loaded = await store.loadWorkflowSnapshot({ workflowName, runId });
    expect(loaded).toMatchObject({ status: 'suspended' });
    await store.updateWorkflowState({ workflowName, runId, opts: { status: 'running' } });

    const run = { runId, resourceId, createdAt, snapshot: { status: 'running' } };
    expect(await store.getWorkflowRunById({ workflowName, runId })).toMatchObject(run);
    expect((await store.listWorkflowRuns({ workflowName, resourceId })).runs).toMatchObject([run]);
    expect((await store.listWorkflowRuns({ workflowName })).runs).toMatchObject([run]);

    await store.deleteWorkflowRunById({ workflowName, runId });
    expect(await store.loadWorkflowSnapshot({ workflowName, runId })).toBeNull();
    expect(await client.get(legacyKey())).toBeNull();
  });
});
