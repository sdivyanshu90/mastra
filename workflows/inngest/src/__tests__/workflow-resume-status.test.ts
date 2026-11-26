import { describe, expect, it } from 'vitest';
import { useWorkflowRunStatusFixture } from './workflow-run-status.fixture';

describe('Inngest workflow resume status', () => {
  const createRun = useWorkflowRunStatusFixture();

  it.each(['success', 'failed', 'running'] as const)('keeps a %s snapshot intact after a late resume', async status => {
    const { run, snapshot, events, load } = await createRun(status);

    await expect.soft(run.resumeAsync({ step: 'approval' })).rejects.toThrow(/not suspended/);
    expect.soft(await load()).toEqual(snapshot);
    expect(events).toEqual([]);
  });

  it('queues a resume for a suspended run', async () => {
    const { run, events, load } = await createRun('suspended');

    await expect(run.resumeAsync({ step: 'approval' })).resolves.toEqual({ runId: run.runId });
    expect(await load()).toMatchObject({ status: 'running' });
    expect(events).toEqual(['workflow.order']);
  });
});
