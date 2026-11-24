import { ErrorCategory, ErrorDomain, MastraError } from '@mastra/core/error';
import {
  createStorageErrorId,
  normalizePerPage,
  TABLE_WORKFLOW_SNAPSHOT,
  matchesExpectedWorkflowStatus,
  WorkflowsStorage,
  ensureDate,
} from '@mastra/core/storage';
import type {
  StorageListWorkflowRunsInput,
  WorkflowRun,
  WorkflowRuns,
  UpdateWorkflowStateOptions,
} from '@mastra/core/storage';
import type { StepResult, WorkflowRunState } from '@mastra/core/workflows';

import { ElasticSearchDB } from '../../db';
import type { ElasticSearchDomainConfig } from '../../db';
import { getKey } from '../utils';

type WorkflowSnapshotRecord = {
  namespace: string;
  workflow_name: string;
  run_id: string;
  resourceId?: string;
  snapshot: WorkflowRunState;
  createdAt: string | Date;
  updatedAt: string | Date;
};

function snapshotKey(namespace: string, workflowName: string, runId: string): string {
  return getKey(TABLE_WORKFLOW_SNAPSHOT, { namespace, workflow_name: workflowName, run_id: runId });
}

function legacySnapshotPrefix(key: string): string {
  return `${key}:resourceId:`;
}

function parseWorkflowRun(row: Record<string, unknown>): WorkflowRun {
  let parsedSnapshot: WorkflowRunState | string = row.snapshot as string;
  if (typeof parsedSnapshot === 'string') {
    try {
      parsedSnapshot = JSON.parse(row.snapshot as string) as WorkflowRunState;
    } catch (e) {
      console.warn(`Failed to parse snapshot for workflow ${row.workflow_name}: ${e}`);
    }
  }

  return {
    workflowName: row.workflow_name as string,
    runId: row.run_id as string,
    snapshot: parsedSnapshot,
    createdAt: ensureDate(row.createdAt as string | Date)!,
    updatedAt: ensureDate(row.updatedAt as string | Date)!,
    resourceId: row.resourceId as string | undefined,
  };
}

export class WorkflowsElasticSearch extends WorkflowsStorage {
  private db: ElasticSearchDB;

  constructor(config: ElasticSearchDomainConfig) {
    super();
    this.db = new ElasticSearchDB({ client: config.client });
  }

  private async getSnapshotRecord(namespace: string, workflowName: string, runId: string) {
    const keys = { namespace, workflow_name: workflowName, run_id: runId };
    const current = await this.db.get<WorkflowSnapshotRecord>({ tableName: TABLE_WORKFLOW_SNAPSHOT, keys });
    if (current) return current;

    const legacy = await this.db.listAll<WorkflowSnapshotRecord>({
      tableName: TABLE_WORKFLOW_SNAPSHOT,
      keyPrefix: legacySnapshotPrefix(snapshotKey(namespace, workflowName, runId)),
    });
    return legacy.find(record => record.workflow_name === workflowName && record.run_id === runId) ?? null;
  }

  public supportsConcurrentUpdates(): boolean {
    return false;
  }

  public async dangerouslyClearAll(): Promise<void> {
    await this.db.deleteData({ tableName: TABLE_WORKFLOW_SNAPSHOT });
  }

  public async updateWorkflowResults({
    workflowName,
    runId,
    stepId,
    result,
    requestContext,
    state,
  }: {
    workflowName: string;
    runId: string;
    stepId: string;
    result: StepResult<unknown, unknown, unknown, unknown>;
    requestContext: Record<string, unknown>;
    state?: Record<string, unknown>;
  }): Promise<Record<string, StepResult<unknown, unknown, unknown, unknown>>> {
    try {
      const existingRecord = await this.getSnapshotRecord('workflows', workflowName, runId);

      const existingSnapshot = existingRecord?.snapshot;
      let snapshot = existingSnapshot;

      if (!snapshot) {
        snapshot = {
          context: {},
          activePaths: [],
          timestamp: Date.now(),
          suspendedPaths: {},
          activeStepsPath: {},
          resumeLabels: {},
          serializedStepGraph: [],
          status: 'pending',
          value: {},
          waitingPaths: {},
          runId,
          requestContext: {},
        } as WorkflowRunState;
      }

      snapshot.context[stepId] = result;
      if (state !== undefined) {
        (snapshot.context as Record<string, unknown>).__state = state;
      }
      snapshot.requestContext = { ...snapshot.requestContext, ...requestContext };

      await this.persistWorkflowSnapshot({
        namespace: 'workflows',
        workflowName,
        runId,
        snapshot,
        resourceId: existingRecord?.resourceId,
        createdAt: existingRecord?.createdAt ? ensureDate(existingRecord.createdAt) : undefined,
      });

      return snapshot.context;
    } catch (error) {
      if (error instanceof MastraError) {
        throw error;
      }
      throw new MastraError(
        {
          id: createStorageErrorId('ELASTICSEARCH', 'UPDATE_WORKFLOW_RESULTS', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: { workflowName, runId, stepId },
        },
        error,
      );
    }
  }

  public async updateWorkflowState({
    workflowName,
    runId,
    opts,
  }: {
    workflowName: string;
    runId: string;
    opts: UpdateWorkflowStateOptions;
  }): Promise<WorkflowRunState | undefined> {
    try {
      const existingRecord = await this.getSnapshotRecord('workflows', workflowName, runId);

      const existingSnapshot = existingRecord?.snapshot;

      if (!existingSnapshot || !existingSnapshot.context) {
        return undefined;
      }

      // Best-effort only: this store reports `supportsConcurrentUpdates() === false`, so the
      // read and the write are not a single critical section.
      const { expectedStatus, ...state } = opts;
      if (!matchesExpectedWorkflowStatus(existingSnapshot.status, expectedStatus)) {
        return undefined;
      }

      const updatedSnapshot = { ...existingSnapshot, ...state };

      await this.persistWorkflowSnapshot({
        namespace: 'workflows',
        workflowName,
        runId,
        snapshot: updatedSnapshot,
        resourceId: existingRecord?.resourceId,
        createdAt: existingRecord?.createdAt ? ensureDate(existingRecord.createdAt) : undefined,
      });

      return updatedSnapshot;
    } catch (error) {
      if (error instanceof MastraError) {
        throw error;
      }
      throw new MastraError(
        {
          id: createStorageErrorId('ELASTICSEARCH', 'UPDATE_WORKFLOW_STATE', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: { workflowName, runId },
        },
        error,
      );
    }
  }

  public async persistWorkflowSnapshot(params: {
    namespace?: string;
    workflowName: string;
    runId: string;
    resourceId?: string;
    snapshot: WorkflowRunState;
    createdAt?: Date;
    updatedAt?: Date;
  }): Promise<void> {
    const { namespace = 'workflows', workflowName, runId, resourceId, snapshot, createdAt, updatedAt } = params;
    try {
      let finalCreatedAt = createdAt;
      let finalResourceId = resourceId;
      if (!finalCreatedAt || finalResourceId === undefined) {
        const keys = { namespace, workflow_name: workflowName, run_id: runId };
        const existing =
          (await this.db.get<WorkflowSnapshotRecord>({ tableName: TABLE_WORKFLOW_SNAPSHOT, keys })) ??
          (resourceId
            ? await this.db.get<WorkflowSnapshotRecord>({
                tableName: TABLE_WORKFLOW_SNAPSHOT,
                keys: { ...keys, resourceId },
              })
            : null);
        finalCreatedAt ??= existing?.createdAt ? ensureDate(existing.createdAt) : new Date();
        finalResourceId ??= existing?.resourceId;
      }

      await this.db.insert({
        tableName: TABLE_WORKFLOW_SNAPSHOT,
        record: {
          namespace,
          workflow_name: workflowName,
          run_id: runId,
          resourceId: finalResourceId,
          snapshot,
          createdAt: finalCreatedAt,
          updatedAt: updatedAt ?? new Date(),
        },
      });
    } catch (error) {
      throw new MastraError(
        {
          id: createStorageErrorId('ELASTICSEARCH', 'PERSIST_WORKFLOW_SNAPSHOT', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: {
            namespace,
            workflowName,
            runId,
          },
        },
        error,
      );
    }
  }

  public async loadWorkflowSnapshot(params: {
    namespace: string;
    workflowName: string;
    runId: string;
  }): Promise<WorkflowRunState | null> {
    const { namespace = 'workflows', workflowName, runId } = params;
    try {
      const record = await this.getSnapshotRecord(namespace, workflowName, runId);
      return record?.snapshot ?? null;
    } catch (error) {
      throw new MastraError(
        {
          id: createStorageErrorId('ELASTICSEARCH', 'LOAD_WORKFLOW_SNAPSHOT', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: {
            namespace,
            workflowName,
            runId,
          },
        },
        error,
      );
    }
  }

  public async getWorkflowRunById({
    runId,
    workflowName,
  }: {
    runId: string;
    workflowName?: string;
  }): Promise<WorkflowRun | null> {
    try {
      const data = workflowName
        ? await this.getSnapshotRecord('workflows', workflowName, runId)
        : (
            await this.db.listAll<WorkflowSnapshotRecord>({
              tableName: TABLE_WORKFLOW_SNAPSHOT,
              keyPrefix: getKey(TABLE_WORKFLOW_SNAPSHOT, { namespace: 'workflows' }),
            })
          ).find(record => record?.run_id === runId);

      if (!data) {
        return null;
      }

      return parseWorkflowRun(data as Record<string, unknown>);
    } catch (error) {
      throw new MastraError(
        {
          id: createStorageErrorId('ELASTICSEARCH', 'GET_WORKFLOW_RUN_BY_ID', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: {
            namespace: 'workflows',
            runId,
            workflowName: workflowName || '',
          },
        },
        error,
      );
    }
  }

  public async deleteWorkflowRunById({ runId, workflowName }: { runId: string; workflowName: string }): Promise<void> {
    const key = snapshotKey('workflows', workflowName, runId);
    try {
      await this.db.deleteData({ tableName: TABLE_WORKFLOW_SNAPSHOT, keyPrefix: legacySnapshotPrefix(key) });
      await this.db.delete({ tableName: TABLE_WORKFLOW_SNAPSHOT, key });
    } catch (error) {
      throw new MastraError(
        {
          id: createStorageErrorId('ELASTICSEARCH', 'DELETE_WORKFLOW_RUN_BY_ID', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: {
            namespace: 'workflows',
            runId,
            workflowName,
          },
        },
        error,
      );
    }
  }

  public async listWorkflowRuns({
    workflowName,
    fromDate,
    toDate,
    perPage,
    page,
    resourceId,
    status,
  }: StorageListWorkflowRunsInput = {}): Promise<WorkflowRuns> {
    try {
      if (page !== undefined && page < 0) {
        throw new MastraError(
          {
            id: createStorageErrorId('ELASTICSEARCH', 'LIST_WORKFLOW_RUNS', 'INVALID_PAGE'),
            domain: ErrorDomain.STORAGE,
            category: ErrorCategory.USER,
            details: { page },
          },
          new Error('page must be >= 0'),
        );
      }

      const normalizedFrom = fromDate ? ensureDate(fromDate) : undefined;
      const normalizedTo = toDate ? ensureDate(toDate) : undefined;

      let keyPrefix = getKey(TABLE_WORKFLOW_SNAPSHOT, { namespace: 'workflows' });
      if (workflowName) {
        keyPrefix = getKey(TABLE_WORKFLOW_SNAPSHOT, { namespace: 'workflows', workflow_name: workflowName }) + ':';
      }
      const entries = await this.db.listAllEntries<WorkflowSnapshotRecord>({
        tableName: TABLE_WORKFLOW_SNAPSHOT,
        keyPrefix,
      });

      const recordsByRun = new Map<string, WorkflowSnapshotRecord>();
      for (const { key, value } of entries) {
        if (!value || typeof value !== 'object' || !('workflow_name' in value)) continue;
        const canonicalKey = snapshotKey('workflows', value.workflow_name, value.run_id);
        if (!recordsByRun.has(canonicalKey) || key === canonicalKey) recordsByRun.set(canonicalKey, value);
      }

      let runs = [...recordsByRun.values()]
        .filter(record => !workflowName || record.workflow_name === workflowName)
        .filter(record => !resourceId || record.resourceId === resourceId)
        .map(w => parseWorkflowRun(w))
        .filter(w => {
          if (normalizedFrom && w.createdAt < normalizedFrom) {
            return false;
          }
          if (normalizedTo && w.createdAt > normalizedTo) {
            return false;
          }
          if (status) {
            let snapshot = w.snapshot;
            if (typeof snapshot === 'string') {
              try {
                snapshot = JSON.parse(snapshot) as WorkflowRunState;
              } catch (e) {
                console.warn(`Failed to parse snapshot for workflow ${w.workflowName}: ${e}`);
                return false;
              }
            }
            return snapshot.status === status;
          }
          return true;
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      const total = runs.length;

      if (typeof perPage === 'number' && typeof page === 'number') {
        const normalizedPerPage = normalizePerPage(perPage, Number.MAX_SAFE_INTEGER);
        const offset = page * normalizedPerPage;
        runs = runs.slice(offset, offset + normalizedPerPage);
      }

      return { runs, total };
    } catch (error) {
      if (error instanceof MastraError) {
        throw error;
      }
      throw new MastraError(
        {
          id: createStorageErrorId('ELASTICSEARCH', 'LIST_WORKFLOW_RUNS', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: {
            namespace: 'workflows',
            workflowName: workflowName || '',
            resourceId: resourceId || '',
          },
        },
        error,
      );
    }
  }
}
