import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const embed = vi.fn((values: string[]) =>
    (async function* () {
      yield values.map(() => [0.1, 0.2, 0.3]);
    })(),
  );

  const countTruncated = vi.fn(async (_values: string[]) => ({ count: 0, maxLength: 0 }));

  return {
    embed,
    countTruncated,
    getCachedModel: vi.fn(async () => ({ embed, countTruncated })),
  };
});

vi.mock('./model-cache.js', () => ({
  getCachedModel: mocks.getCachedModel,
  warmupFastEmbedModels: vi.fn(async () => undefined),
}));

beforeEach(() => {
  mocks.embed.mockClear();
  mocks.getCachedModel.mockClear();
  mocks.countTruncated.mockClear();
});

test('registers role specific multilingual e5 models on the v3 provider', async () => {
  const { fastembed } = await import('./index.js');

  expect(fastembed.multilingualE5LargeQuery.modelId).toBe('multilingual-e5-large-query');
  expect(fastembed.multilingualE5LargePassage.modelId).toBe('multilingual-e5-large-passage');
  for (const model of [fastembed.multilingualE5LargeQuery, fastembed.multilingualE5LargePassage]) {
    expect(model.specificationVersion).toBe('v3');
    expect(model.provider).toBe('fastembed');
  }
});

test('applies the query prefix and uses the multilingual model', async () => {
  const { fastembed } = await import('./index.js');

  const result = await fastembed.multilingualE5LargeQuery.doEmbed({ values: ['مرحبا', 'hello'] });

  expect(mocks.getCachedModel).toHaveBeenCalledWith('MLE5Large');
  expect(mocks.embed).toHaveBeenCalledWith(['query: مرحبا', 'query: hello']);
  expect(result.embeddings).toHaveLength(2);
  expect(result.warnings).toEqual([]);
});

test('applies the passage prefix', async () => {
  const { fastembed } = await import('./index.js');

  await fastembed.multilingualE5LargePassage.doEmbed({ values: ['مرحبا'] });

  expect(mocks.getCachedModel).toHaveBeenCalledWith('MLE5Large');
  expect(mocks.embed).toHaveBeenCalledWith(['passage: مرحبا']);
});

test('leaves bge model inputs unprefixed', async () => {
  const { fastembed } = await import('./index.js');

  await fastembed.small.doEmbed({ values: ['hello'] });

  expect(mocks.getCachedModel).toHaveBeenCalledWith('BGESmallENV15');
  expect(mocks.embed).toHaveBeenCalledWith(['hello']);
});

test('returns no warnings when every input fits the token window', async () => {
  const { fastembed } = await import('./index.js');

  const result = await fastembed.small.doEmbed({ values: ['hello', 'world'] });

  expect(mocks.countTruncated).toHaveBeenCalledWith(['hello', 'world']);
  expect(result.warnings).toEqual([]);
});

test('warns when inputs exceed the token window and are truncated', async () => {
  mocks.countTruncated.mockResolvedValueOnce({ count: 1, maxLength: 512 });
  const { fastembed } = await import('./index.js');

  const result = await fastembed.base.doEmbed({ values: ['long text', 'short'] });

  expect(result.embeddings).toHaveLength(2);
  expect(result.warnings).toEqual([
    {
      type: 'other',
      message: expect.stringContaining("1 of 2 inputs exceed the model's 512-token window and were truncated"),
    },
  ]);
});

test('counts truncation on the prefixed e5 inputs', async () => {
  const { fastembed } = await import('./index.js');

  await fastembed.multilingualE5LargePassage.doEmbed({ values: ['hello'] });

  expect(mocks.countTruncated).toHaveBeenCalledWith(['passage: hello']);
});

const providerModels = [
  'smallLegacy',
  'baseLegacy',
  'smallV2',
  'baseV2',
  'small',
  'base',
  'multilingualE5LargeQuery',
  'multilingualE5LargePassage',
] as const;

test.each(providerModels)('%s rejects fewer embeddings than input texts', async modelName => {
  mocks.embed.mockImplementationOnce(() =>
    (async function* () {
      yield [[0.1, 0.2, 0.3]];
    })(),
  );
  const { fastembed } = await import('./index.js');

  await expect(fastembed[modelName].doEmbed({ values: ['first', 'second'] })).rejects.toThrow(
    'FastEmbed embedding count mismatch: expected 2, received 1',
  );
  expect(mocks.countTruncated).not.toHaveBeenCalled();
});

test.each(providerModels)('%s rejects more embeddings than input texts', async modelName => {
  mocks.embed.mockImplementationOnce(() =>
    (async function* () {
      yield [[0.1], [0.2]];
      yield [[0.3]];
    })(),
  );
  const { fastembed } = await import('./index.js');

  await expect(fastembed[modelName].doEmbed({ values: ['first', 'second'] })).rejects.toThrow(
    'FastEmbed embedding count mismatch: expected 2, received 3',
  );
});

test.each(providerModels)('%s preserves embedding order across valid batches', async modelName => {
  mocks.embed.mockImplementationOnce(() =>
    (async function* () {
      yield [[0.1, 0.2]];
      yield [
        [0.3, 0.4],
        [0.5, 0.6],
      ];
    })(),
  );
  const { fastembed } = await import('./index.js');

  const result = await fastembed[modelName].doEmbed({ values: ['first', 'second', 'third'] });

  expect(result.embeddings).toEqual([
    [0.1, 0.2],
    [0.3, 0.4],
    [0.5, 0.6],
  ]);
});
