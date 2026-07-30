export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer");
  }

  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

export class PromiseAssetCache<T> {
  private readonly promises = new Map<string, Promise<T>>();

  constructor(private readonly loadAsset: (url: string) => Promise<T>) {}

  load(url: string): Promise<T> {
    const existing = this.promises.get(url);
    if (existing) return existing;

    const pending = this.loadAsset(url).catch((error) => {
      this.promises.delete(url);
      throw error;
    });
    this.promises.set(url, pending);
    return pending;
  }

  delete(url: string) {
    this.promises.delete(url);
  }

  clear() {
    this.promises.clear();
  }
}
