import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTransport } from './file/index.js';
import { UpstashTransport } from './upstash/index.js';

describe.each(['file', 'upstash'] as const)('%s transport pagination', kind => {
  const records = Array.from({ length: 5 }, (_, index) => ({ msg: `log-${index}`, time: index, runId: 'run' }));
  let transport: FileTransport | UpstashTransport;
  let directory: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (_url: string, request: RequestInit) => ({
      ok: true,
      json: async () =>
        JSON.parse(request.body as string).map(([command, , start, end]: [string, string, number, number]) => ({
          result:
            command === 'LLEN'
              ? records.length
              : records
                  .slice(start < 0 ? records.length + start : start, end < 0 ? records.length + end + 1 : end + 1)
                  .map(record => JSON.stringify(record)),
        })),
    }));
    vi.stubGlobal('fetch', fetchMock);

    if (kind === 'file') {
      directory = mkdtempSync(join(tmpdir(), 'mastra-log-pagination-'));
      const path = join(directory, 'logs.jsonl');
      writeFileSync(path, records.map(record => JSON.stringify(record)).join('\n'));
      transport = new FileTransport({ path });
    } else {
      transport = new UpstashTransport({ upstashUrl: 'https://example.com', upstashToken: 'test' });
    }
  });

  afterEach(async () => {
    if (transport instanceof FileTransport) {
      const closed = once(transport.fileStream, 'close');
      transport.destroy();
      await closed;
      rmSync(directory, { recursive: true });
    } else {
      transport.destroy();
    }
    vi.unstubAllGlobals();
  });

  describe.each(['listLogs', 'listLogsByRunId'] as const)('%s', method => {
    it.each([
      { page: -1 },
      { page: 1.5 },
      { page: NaN },
      { page: Infinity },
      { page: Number.MAX_SAFE_INTEGER + 1 },
      { perPage: -1 },
      { perPage: 1.5 },
      { perPage: NaN },
      { perPage: Infinity },
      { perPage: Number.MAX_SAFE_INTEGER + 1 },
      { page: Number.MAX_SAFE_INTEGER, perPage: 2 },
    ])('rejects invalid pagination %j before querying logs', async params => {
      await expect(transport[method]({ runId: 'run', ...params })).rejects.toThrow(RangeError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('preserves zero pagination aliases', async () => {
      const result = await transport[method]({ runId: 'run', page: 0, perPage: 0 });

      expect(result).toEqual({ logs: records, total: 5, page: 1, perPage: 100, hasMore: false });
    });

    it('returns the requested page with accurate metadata', async () => {
      const result = await transport[method]({ runId: 'run', page: 2, perPage: 2 });

      expect(result).toEqual({ logs: records.slice(2, 4), total: 5, page: 2, perPage: 2, hasMore: true });
    });
  });

  it('returns all records when pagination is disabled', async () => {
    const result = await transport.listLogs({ returnPaginationResults: false });

    expect(result).toEqual({ logs: records, total: 5, page: 1, perPage: 5, hasMore: false });
  });
});
