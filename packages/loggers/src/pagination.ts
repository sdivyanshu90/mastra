export function normalizeLogPagination(params?: { page?: number; perPage?: number }): {
  page: number;
  perPage: number;
} {
  const page = params?.page === 0 ? 1 : (params?.page ?? 1);
  const perPage = params?.perPage === 0 ? 100 : (params?.perPage ?? 100);

  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError('page must be a positive safe integer or zero');
  }
  if (!Number.isSafeInteger(perPage) || perPage < 1) {
    throw new RangeError('perPage must be a positive safe integer or zero');
  }
  if (!Number.isSafeInteger(page * perPage)) {
    throw new RangeError('page and perPage must produce safe integer offsets');
  }

  return { page, perPage };
}
