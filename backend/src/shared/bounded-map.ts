/**
 * A Map that forgets its least recently used entry instead of growing forever.
 *
 * Several caches in the platform are keyed by something a tenant controls —
 * a provider id, an extension slug, a backup id. On one instance serving one
 * organization they hold a handful of entries. On one instance serving a
 * thousand organizations they hold whatever a thousand organizations have
 * created, and nothing ever removes an entry, so the process grows until it is
 * restarted. That is not a leak in the usual sense — every entry is reachable
 * and legitimately cached — which is precisely why it survives review: the code
 * looks correct, and it is correct, for one tenant.
 *
 * The fix is a ceiling. `Map` in JavaScript preserves insertion order, so
 * "least recently used" is the first key, and touching an entry means deleting
 * and reinserting it. That is O(1) and needs no bookkeeping structure.
 *
 * `weigh` lets a cache be bounded by something other than entry count — bytes,
 * for a cache of buffers, where ten entries can mean ten megabytes or ten
 * gigabytes.
 */
export class BoundedMap<K, V> {
  private readonly entries = new Map<K, V>();
  private weight = 0;
  private evictions = 0;

  constructor(
    /** Maximum entries, or maximum total weight when `weigh` is supplied. */
    private readonly limit: number,
    private readonly weigh?: (value: V) => number,
    /** Called with each evicted entry, for caches holding a closable resource. */
    private readonly onEvict?: (key: K, value: V) => void,
  ) {
    if (limit < 1) throw new Error('A bounded map needs room for at least one entry');
  }

  get size(): number {
    return this.entries.size;
  }

  /** Total weight held, or the entry count when unweighed. */
  get load(): number {
    return this.weigh ? this.weight : this.entries.size;
  }

  /** How many entries have been dropped to stay under the limit. */
  get evicted(): number {
    return this.evictions;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** Reading marks the entry as recently used. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    // Re-insert so it moves to the back of the eviction queue.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.weight -= this.weigh?.(existing) ?? 0;
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.weight += this.weigh?.(value) ?? 0;
    this.evict();
    return this;
  }

  delete(key: K): boolean {
    const existing = this.entries.get(key);
    if (existing === undefined) return this.entries.delete(key);
    this.weight -= this.weigh?.(existing) ?? 0;
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.weight = 0;
  }

  keys(): IterableIterator<K> {
    return this.entries.keys();
  }

  values(): IterableIterator<V> {
    return this.entries.values();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries[Symbol.iterator]();
  }

  private evict(): void {
    // The newest entry is never evicted, even if it alone exceeds the limit:
    // dropping the thing that was just stored would make the cache silently
    // useless rather than merely bounded.
    while (this.load > this.limit && this.entries.size > 1) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      const value = this.entries.get(oldest.value) as V;
      this.entries.delete(oldest.value);
      this.weight -= this.weigh?.(value) ?? 0;
      this.evictions += 1;
      this.onEvict?.(oldest.value, value);
    }
  }
}
