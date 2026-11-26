import { describe, expect, it } from 'vitest';
import { useWorkflowRunStatusFixture } from './workflow-run-status.fixture';

describe('Inngest workflow cancel status', () => {
  const createRun = useWorkflowRunStatusFixture();

  it.each(['success', 'failed', 'canceled', 'tripwire', 'bailed'] as const)(
    'keeps a %s snapshot intact after a late cancel',
    async status => {
      const { run, snapshot, events, load } = await createRun(status);

      await run.cancel();

      expect.soft(await load()).toEqual(snapshot);
      expect(events).toEqual([]);
    },
  );

  it('sends a cancel event and stores cancellation for an active run', async () => {
    const { run, events, load } = await createRun('running');

    await run.cancel();

    expect(await load()).toMatchObject({ status: 'canceled' });
    expect(events).toEqual(['cancel.workflow.order']);
  });
});
