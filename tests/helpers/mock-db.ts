/**
 * Hand-rolled fluent Drizzle stub.
 *
 * The production code imports a module-scope `db` singleton (src/shared/db.ts)
 * that opens a real pg pool at import time, so unit tests replace it wholesale
 * via `vi.mock('../../src/shared/db.js', () => ({ db: mock.db, pool: {...} }))`.
 *
 * Usage:
 *   const mock = createMockDb();
 *   mock.queueSelect('agent_types', [{ id: '...', slug: 'support' }]);
 *   mock.queueReturning([{ id: 'new-id' }]);
 *   // ...run code under test...
 *   expect(mock.inserts).toContainEqual({ table: 'llm_usage_logs', values: expect.any(Object) });
 *
 * Select results are FIFO-queued per table name (getTableName). insert/update/
 * delete calls are recorded for assertion; `.returning()` drains the returning
 * queue. Anything not queued resolves to an empty array so code paths that
 * merely await a write don't throw.
 */
import { getTableName, type Table } from 'drizzle-orm';
import { vi } from 'vitest';

type Row = Record<string, unknown>;

export interface InsertCall { table: string; values: unknown }
export interface UpdateCall { table: string; set: unknown }
export interface DeleteCall { table: string }

export interface MockDb {
  db: MockDbClient;
  queueSelect(table: string, rows: Row[]): void;
  queueReturning(rows: Row[]): void;
  queueExecute(result: { rows: Row[] }): void;
  inserts: InsertCall[];
  updates: UpdateCall[];
  deletes: DeleteCall[];
  transactions: number;
  reset(): void;
}

// Minimal structural type matching the surface the code uses off `db`.
export interface MockDbClient {
  select: (...args: unknown[]) => QueryBuilder;
  insert: (table: Table) => QueryBuilder;
  update: (table: Table) => QueryBuilder;
  delete: (table: Table) => QueryBuilder;
  execute: (...args: unknown[]) => Promise<{ rows: Row[] }>;
  // Replays the callback against the same fluent stub (no real isolation) and
  // records the boundary so tests can assert work happened inside a transaction.
  transaction: <T>(cb: (tx: MockDbClient) => Promise<T>) => Promise<T>;
}

type Kind = 'select' | 'insert' | 'update' | 'delete';

class QueryBuilder implements PromiseLike<unknown> {
  private table = '';
  private returningRequested = false;

  constructor(
    private readonly kind: Kind,
    private readonly state: MockState,
  ) {}

  // ── chain methods (all return `this`) ──
  from(table: Table): this { this.table = getTableName(table); return this; }
  where(): this { return this; }
  orderBy(): this { return this; }
  limit(): this { return this; }
  offset(): this { return this; }
  groupBy(): this { return this; }
  innerJoin(): this { return this; }
  leftJoin(): this { return this; }
  for(): this { return this; }        // SELECT ... FOR UPDATE
  onConflictDoNothing(): this { return this; }
  onConflictDoUpdate(): this { return this; }

  values(v: unknown): this {
    this.state.inserts.push({ table: this.table, values: v });
    return this;
  }
  set(v: unknown): this {
    this.state.updates.push({ table: this.table, set: v });
    return this;
  }
  returning(): this { this.returningRequested = true; return this; }

  // Called by insert(table)/update(table)/delete(table) factories.
  setTable(table: Table): this {
    this.table = getTableName(table);
    if (this.kind === 'delete') this.state.deletes.push({ table: this.table });
    return this;
  }

  private resolve(): unknown {
    if (this.kind === 'select') {
      const q = this.state.selectResults.get(this.table);
      return q && q.length > 0 ? q.shift() : [];
    }
    if (this.returningRequested) {
      return this.state.returningResults.length > 0 ? this.state.returningResults.shift() : [];
    }
    return [];
  }

  then<TR1 = unknown, TR2 = never>(
    onfulfilled?: ((value: unknown) => TR1 | PromiseLike<TR1>) | null,
    onrejected?: ((reason: unknown) => TR2 | PromiseLike<TR2>) | null,
  ): Promise<TR1 | TR2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

interface MockState {
  selectResults: Map<string, Row[][]>;
  returningResults: Row[][];
  executeResults: Array<{ rows: Row[] }>;
  inserts: InsertCall[];
  updates: UpdateCall[];
  deletes: DeleteCall[];
  transactions: number;
}

export function createMockDb(): MockDb {
  const state: MockState = {
    selectResults: new Map(),
    returningResults: [],
    executeResults: [],
    inserts: [],
    updates: [],
    deletes: [],
    transactions: 0,
  };

  const db: MockDbClient = {
    select: () => new QueryBuilder('select', state),
    insert: (table: Table) => new QueryBuilder('insert', state).setTable(table),
    update: (table: Table) => new QueryBuilder('update', state).setTable(table),
    delete: (table: Table) => new QueryBuilder('delete', state).setTable(table),
    execute: vi.fn(async () =>
      state.executeResults.length > 0 ? state.executeResults.shift()! : { rows: [] },
    ),
    transaction: async (cb) => {
      state.transactions++;
      return cb(db);
    },
  };

  return {
    db,
    queueSelect(table, rows) {
      const q = state.selectResults.get(table) ?? [];
      q.push(rows);
      state.selectResults.set(table, q);
    },
    queueReturning(rows) { state.returningResults.push(rows); },
    queueExecute(result) { state.executeResults.push(result); },
    get inserts() { return state.inserts; },
    get updates() { return state.updates; },
    get deletes() { return state.deletes; },
    get transactions() { return state.transactions; },
    reset() {
      state.selectResults.clear();
      state.returningResults = [];
      state.executeResults = [];
      state.inserts = [];
      state.updates = [];
      state.deletes = [];
      state.transactions = 0;
    },
  };
}
