/** 等待指定毫秒（重试退避用） */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带并发上限的映射。保持输入顺序返回结果。
 * 自写实现，不引 p-limit。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const total = items.length;
  if (total === 0) return [];

  const concurrency = Math.max(1, Math.min(Math.floor(limit) || 1, total));
  const results = new Array<R>(total);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= total) return;
      results[index] = await fn(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
