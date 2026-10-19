import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingModel, FlagEmbedding, SparseTextEmbedding } from './fastembed';

vi.mock('onnxruntime-node', () => ({
  Tensor: class {
    constructor(
      public type: string,
      public data: unknown,
      public dims: number[],
    ) {}
  },
}));

const encode = vi.fn(async (text: string) => ({
  getIds: () => [text.length],
  getAttentionMask: () => [1],
  getTypeIds: () => [0],
  getOverflowing: () => [],
  getLength: () => 1,
}));
const run = vi.fn(async (inputs: Record<string, { dims: number[] }>) => {
  const size = inputs.input_ids!.dims[0]!;
  return {
    last_hidden_state: { data: Array.from({ length: size }, () => [3, 4]).flat(), dims: [size, 1, 2] },
    output: { cpuData: new Float32Array(Array.from({ length: size }, () => [0, 1]).flat()), dims: [size, 1, 2] },
  };
});
const dense = () =>
  Reflect.construct(FlagEmbedding, [{ encode }, { run }, EmbeddingModel.BGESmallENV15]) as FlagEmbedding;
const sparse = () => Reflect.construct(SparseTextEmbedding, [{ encode }, { run }]) as SparseTextEmbedding;

const operations = [
  { name: 'dense embed', invoke: (texts: string[], size: number) => dense().embed(texts, size).next() },
  { name: 'dense passageEmbed', invoke: (texts: string[], size: number) => dense().passageEmbed(texts, size).next() },
  { name: 'sparse embed', invoke: (texts: string[], size: number) => sparse().embed(texts, size).next() },
  { name: 'sparse passageEmbed', invoke: (texts: string[], size: number) => sparse().passageEmbed(texts, size).next() },
  { name: 'countTruncated', invoke: (texts: string[], size: number) => dense().countTruncated(texts, size) },
];

beforeEach(() => {
  encode.mockClear();
  run.mockClear();
});

describe.each(operations)('$name batch sizes', ({ invoke }) => {
  it.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s even when the input is empty',
    async size => {
      await expect(invoke([], size)).rejects.toThrow('batchSize must be a positive safe integer');
      expect(encode).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('rejects zero before entering processing with nonempty input', async () => {
    let lengthReads = 0;
    const texts = new Proxy(['text'], {
      get(target, key, receiver) {
        // Bound the current countTruncated zero-step loop without ever running it indefinitely.
        if (key === 'length' && ++lengthReads > 2) throw new Error('bounded invalid-batch probe');
        return Reflect.get(target, key, receiver);
      },
    });

    await expect(invoke(texts, 0)).rejects.toThrow('batchSize must be a positive safe integer');
    expect(encode).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

it.each([dense, sparse])('retains positive batching and the final partial batch', async create => {
  const batches = [];
  for await (const batch of create().embed(['first', 'second', 'third'], 2)) batches.push(batch);

  expect(batches.map(batch => batch.length)).toEqual([2, 1]);
  expect(encode.mock.calls.map(([text]) => text)).toEqual(['first', 'second', 'third']);
  expect(run).toHaveBeenCalledTimes(2);
});

it('preserves valid truncation counting', async () => {
  expect(await dense().countTruncated(['first', 'second', 'third'], 2)).toEqual({ count: 0, maxLength: 0 });
  expect(encode).toHaveBeenCalledTimes(3);
  expect(run).not.toHaveBeenCalled();
});
