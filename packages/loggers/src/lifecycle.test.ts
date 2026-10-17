import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

async function runTransport(
  kind: 'http' | 'upstash',
  scenario: 'idle' | 'flushed' | 'automatic' | 'retry' | 'cleared',
) {
  const moduleUrl = new URL(`./${kind}/index.ts`, import.meta.url).href;
  const className = kind === 'http' ? 'HttpTransport' : 'UpstashTransport';
  const options =
    kind === 'http'
      ? { url: 'https://example.invalid', flushInterval: 20, retryOptions: { maxRetries: 0 } }
      : { upstashUrl: 'https://example.invalid', upstashToken: 'test', flushInterval: 20 };
  const script = `
    import { writeSync } from 'node:fs';
    import { ${className} as Transport } from ${JSON.stringify(moduleUrl)};
    const scenario = ${JSON.stringify(scenario)};
    const delivered = [];
    let attempts = 0;
    globalThis.fetch = async (_url, request) => {
      attempts++;
      if (scenario === 'retry' && attempts === 1) throw new Error('temporary failure');
      const body = JSON.parse(request.body);
      const logs = ${JSON.stringify(kind)} === 'http' ? body.logs : body[0].slice(2).map(log => JSON.parse(log));
      delivered.push(...logs.map(log => log.msg));
      return { ok: true, json: async () => [{ result: delivered.length }, { result: 'OK' }] };
    };
    console.error = () => {};
    const transport = new Transport(${JSON.stringify(options)});
    process.once('exit', () => {
      writeSync(1, JSON.stringify({ attempts, delivered, timerHasRef: transport.flushIntervalId.hasRef() }));
    });
    if (scenario !== 'idle') transport.write(JSON.stringify({ msg: 'buffered', time: 1 }));
    if (scenario === 'flushed') await transport._flush();
    if (scenario === 'cleared') transport.clearBuffer();
  `;

  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    {
      timeout: 4000,
    },
  );
  return JSON.parse(stdout);
}

describe.each(['http', 'upstash'] as const)('%s transport process lifecycle', kind => {
  it('lets an idle process exit without explicit destruction', async () => {
    expect(await runTransport(kind, 'idle')).toEqual({ attempts: 0, delivered: [], timerHasRef: false });
  });

  it('lets a process exit after an explicit flush', async () => {
    expect(await runTransport(kind, 'flushed')).toEqual({ attempts: 1, delivered: ['buffered'], timerHasRef: false });
  });

  it('keeps pending logs alive until the automatic flush completes', async () => {
    expect(await runTransport(kind, 'automatic')).toEqual({ attempts: 1, delivered: ['buffered'], timerHasRef: false });
  });

  it('keeps failed batches alive until a later interval delivers them', async () => {
    expect(await runTransport(kind, 'retry')).toEqual({ attempts: 2, delivered: ['buffered'], timerHasRef: false });
  });
});

it('lets an HTTP transport process exit after clearing its buffer', async () => {
  expect(await runTransport('http', 'cleared')).toEqual({ attempts: 0, delivered: [], timerHasRef: false });
});
