/**
 * BoundedQueue — fixed-capacity FIFO queue with backpressure.
 *
 * Push returns `false` when the queue is full instead of blocking; this lets
 * the caller decide: drop, log, retry-with-delay, or shed to another worker.
 *
 * Designed for async request pipelines where unbounded buffering hides
 * memory leaks and unbounded concurrency magnifies them. Pair with a
 * `Semaphore` for admission control and a `RateLimitedSemaphore` for
 * upstream rate-limiting.
 *
 * Use cases:
 *   - Bounded outbound request buffer for a worker pool.
 *   - "Latest-N" event caches that evict oldest on overflow.
 *   - De-duplicating coalescers (push returns false if same id is already queued).
 *
 * Implementation notes:
 *   - Backed by a plain array; head pointer advances on shift() to keep
 *     pop O(1) amortized even though we don't physically remove slots.
 *   - Not thread-safe; intended for single-event-loop JS runtimes.
 */

export interface BoundedQueueOptions<T> {
  /** Hard capacity; push returns false beyond this. Default 1024. */
  capacity?: number;
  /** When full, drop the OLDEST item to make room for the new one. Default false. */
  dropOldest?: boolean;
}

export class BoundedQueue<T> {
  private readonly _buffer: (T | undefined)[];
  private _head = 0;        // index of next item to pop
  private _tail = 0;        // index of next free slot to push
  private _size = 0;
  private _dropped = 0;     // counter of items dropped by dropOldest policy
  private readonly _capacity: number;
  private readonly _dropOldest: boolean;

  constructor(opts: BoundedQueueOptions<T> = {}) {
    this._capacity = Math.max(1, opts.capacity ?? 1024);
    this._dropOldest = opts.dropOldest ?? false;
    this._buffer = new Array(this._capacity);
  }

  get capacity(): number {
    return this._capacity;
  }

  get size(): number {
    return this._size;
  }

  get isEmpty(): boolean {
    return this._size === 0;
  }

  get isFull(): boolean {
    return this._size === this._capacity;
  }

  /** Total items dropped (overflow policy applied). */
  get droppedCount(): number {
    return this._dropped;
  }

  /**
   * Append `item` to the tail.
   * @returns true if accepted; false if the queue was full and dropOldest=false.
   *          If dropOldest=true, always returns true (oldest evicted if needed).
   */
  push(item: T): boolean {
    if (this._size === this._capacity) {
      if (!this._dropOldest) return false;
      // Evict oldest by advancing head.
      this._head = (this._head + 1) % this._capacity;
      this._size--;
      this._dropped++;
    }
    this._buffer[this._tail] = item;
    this._tail = (this._tail + 1) % this._capacity;
    this._size++;
    return true;
  }

  /** Remove and return the head item, or undefined if empty. */
  shift(): T | undefined {
    if (this._size === 0) return undefined;
    const item = this._buffer[this._head];
    this._buffer[this._head] = undefined;     // help GC for object payloads
    this._head = (this._head + 1) % this._capacity;
    this._size--;
    return item;
  }

  /** Peek at the head item without removing it. */
  peek(): T | undefined {
    return this._size === 0 ? undefined : this._buffer[this._head];
  }

  /** Empty the queue and return all items in FIFO order. */
  drain(): T[] {
    const out: T[] = [];
    while (this._size > 0) out.push(this.shift() as T);
    return out;
  }

  /**
   * Apply `fn(item)` to every queued item in FIFO order without mutating.
   * Returns the items array so callers can chain; safe to mutate via the copy.
   */
  inspect(fn: (item: T, index: number) => void): T[] {
    const out: T[] = [];
    let idx = this._head;
    for (let i = 0; i < this._size; i++) {
      const item = this._buffer[idx] as T;
      fn(item, i);
      out.push(item);
      idx = (idx + 1) % this._capacity;
    }
    return out;
  }

  /** Remove all items. Returns the count that was cleared. */
  clear(): number {
    const n = this._size;
    for (let i = 0; i < this._capacity; i++) this._buffer[i] = undefined;
    this._head = 0;
    this._tail = 0;
    this._size = 0;
    return n;
  }
}