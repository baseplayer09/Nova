import assert from 'node:assert/strict';
import test from 'node:test';
import { setUserRlsContext, type RlsTransaction } from './database.js';

test('RLS setup installs the verified user claims before switching roles', async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const transaction: RlsTransaction = {
    async $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
      statements.push({ sql: strings.join('?'), values });
      return [] as T;
    },
    async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
      statements.push({ sql: strings.join('?'), values });
      return 0;
    },
  };
  const userId = 'c0a80123-4567-489a-8bcd-ef0123456789';

  await setUserRlsContext(transaction, userId);

  assert.deepEqual(statements, [
    {
      sql: "\n    SELECT set_config('request.jwt.claim.sub', ?, true)\n  ",
      values: [userId],
    },
    {
      sql: "\n    SELECT set_config('request.jwt.claims', ?, true)\n  ",
      values: [
        JSON.stringify({
          sub: userId,
          role: 'authenticated',
          aud: 'authenticated',
        }),
      ],
    },
    {
      sql: 'SET LOCAL ROLE nova_app',
      values: [],
    },
  ]);
});

test('RLS setup rejects an invalid user ID before issuing SQL', async () => {
  let issuedQuery = false;
  const transaction: RlsTransaction = {
    async $queryRaw<T>(): Promise<T> {
      issuedQuery = true;
      return [] as T;
    },
    async $executeRaw(): Promise<number> {
      issuedQuery = true;
      return 0;
    },
  };

  await assert.rejects(
    setUserRlsContext(transaction, 'not-a-uuid'),
    /A valid Supabase user ID is required/,
  );
  assert.equal(issuedQuery, false);
});
