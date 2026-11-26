import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoRecords, Workspace } from '@cuttingfloor/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FileLedger,
  Insufficient,
  type Ledger,
  MongoLedger,
  NoCreditAccount,
  totals,
} from '../src/ledger.ts';
import { MONGO_TEST_TIMEOUT_MS, mongoReachable, TEST_MONGODB_URI, testDatabase } from './mongo.ts';

// The credit ledger's own rules, the same on both stores: an account opens once, an entry is
// written once by its id, a spend never takes the balance below zero, and the balance and totals
// are always what the entries sum to. MongoDB's suite runs against scripts/test-mongo.sh.

const A = 'user_01LEDGERSTOREAAAAAAAAAAAA1';
const B = 'user_01LEDGERSTOREBBBBBBBBBBBB2';
const LOW = 5;

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of closers) await close();
});

async function fileLedger(): Promise<Ledger> {
  const ws = new Workspace(await mkdtemp(join(tmpdir(), 'cf-ledger-store-')));
  return new FileLedger({ records: ws.records, low: LOW });
}

async function mongoLedger(): Promise<Ledger> {
  const records = new MongoRecords({ uri: TEST_MONGODB_URI, db: testDatabase() });
  closers.push(async () => {
    await (await records.database()).dropDatabase();
    await records.close();
  });
  return new MongoLedger({ db: () => records.database(), low: LOW });
}

const opening =
  (credits = 3) =>
  async () => ({
    used_before: 1.5,
    entries: [{ id: 'grant:activation', kind: 'grant' as const, credits }],
  });

const stores: [string, () => Promise<Ledger>, boolean][] = [
  ['filesystem', fileLedger, true],
  ['MongoDB', mongoLedger, await mongoReachable()],
];

for (const [name, make, up] of stores) {
  describe.skipIf(!up)(`the credit ledger on ${name}`, { timeout: MONGO_TEST_TIMEOUT_MS }, () => {
    it('opens an account once, with its entries, however many open it at once', async () => {
      const ledger = await make();
      expect(await ledger.get(A)).toBeUndefined();
      let calls = 0;
      const opened = await Promise.all(
        [1, 2, 3].map(() =>
          ledger.open(A, async () => {
            calls++;
            return opening()();
          }),
        ),
      );
      for (const account of opened) expect(account).toMatchObject({ balance: 3, granted_total: 3 });
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(await ledger.entries(A)).toHaveLength(1);
      expect(await ledger.get(A)).toMatchObject({ used_before: 1.5, refill: null });
      expect(await ledger.owners()).toEqual([A]);
    });

    it('spends once under an id, and says where it crossed', async () => {
      const ledger = await make();
      await ledger.open(A, opening(10));
      const first = await ledger.spend(A, {
        id: 'j_1-release',
        credits: 5.25,
        tool: 'export.release',
      });
      expect(first).toEqual({ balance: 4.75, duplicate: false, crossed: 'low' });
      const again = await ledger.spend(A, {
        id: 'j_1-release',
        credits: 5.25,
        tool: 'export.release',
      });
      expect(again).toMatchObject({ balance: 4.75, duplicate: true, crossed: null });
      const out = await ledger.spend(A, {
        id: 'j_2-release',
        credits: 4.75,
        tool: 'export.release',
      });
      expect(out).toEqual({ balance: 0, duplicate: false, crossed: 'out' });
      expect(await ledger.get(A)).toMatchObject({ balance: 0, used_total: 10 });
    });

    it('never spends past zero: a spend over the balance changes nothing', async () => {
      const ledger = await make();
      await ledger.open(A, opening(2));
      const refused = await ledger
        .spend(A, { id: 'j_big-release', credits: 2.25, tool: 'export.release' })
        .catch((e) => e);
      expect(refused).toBeInstanceOf(Insufficient);
      expect((refused as Insufficient).balance).toBe(2);
      expect(await ledger.get(A)).toMatchObject({ balance: 2, used_total: 0 });
      expect(await ledger.entries(A)).toHaveLength(1);
      await expect(
        ledger.spend(B, { id: 'j_x-release', credits: 1, tool: 'export.release' }),
      ).rejects.toBeInstanceOf(NoCreditAccount);
    });

    it('spends once when the same release comes at once, and only what the balance covers', async () => {
      const ledger = await make();
      await ledger.open(A, opening(3));
      const same = await Promise.all(
        [1, 2, 3, 4].map(() =>
          ledger.spend(A, { id: 'j_same-release', credits: 2, tool: 'export.release' }),
        ),
      );
      expect(same.filter((s) => !s.duplicate)).toHaveLength(1);
      expect((await ledger.get(A))?.balance).toBe(1);
      // Two different releases of 1 each against a balance of 1: one goes through.
      const both = await Promise.allSettled([
        ledger.spend(A, { id: 'j_a-release', credits: 1, tool: 'export.release' }),
        ledger.spend(A, { id: 'j_b-release', credits: 1, tool: 'export.release' }),
      ]);
      expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await ledger.get(A))?.balance).toBe(0);
    });

    it('credits payments and refunds once, and a refund may take the balance below zero', async () => {
      const ledger = await make();
      await ledger.open(A, opening(3));
      const bought = await ledger.credit(A, {
        id: 'pi_1',
        kind: 'purchase',
        credits: 55,
        pack: 'cf_credits_10',
        payment_intent: 'pi_1',
      });
      expect(bought).toMatchObject({
        duplicate: false,
        account: { balance: 58, bought_total: 55 },
      });
      expect(
        (await ledger.credit(A, { id: 'pi_1', kind: 'purchase', credits: 55 })).duplicate,
      ).toBe(true);
      await ledger.spend(A, { id: 'j_1-release', credits: 50, tool: 'export.release' });
      const refunded = await ledger.credit(A, { id: 're_1', kind: 'refund', credits: -55 });
      expect(refunded.account).toMatchObject({ balance: -47, bought_total: 0 });
      expect((await ledger.findEntry('pi_1'))?.owner).toBe(A);
      expect(await ledger.findEntry('pi_none')).toBeUndefined();
    });

    it('keeps the balance and totals equal to what the entries sum to', async () => {
      const ledger = await make();
      await ledger.open(A, async () => ({
        used_before: 0,
        entries: [
          { id: 'opening:ca_1', kind: 'opening', credits: 10.1 },
          { id: 'pi_a', kind: 'purchase', credits: 27.5 },
          { id: 'old-release', kind: 'spend', credits: -0.2 },
        ],
      }));
      await ledger.credit(A, { id: 'adjust:1', kind: 'adjust', credits: 0.1, reason: 'test' });
      await ledger.spend(A, { id: 'j_1-release', credits: 0.25, tool: 'export.release' });
      const account = await ledger.get(A);
      const summed = totals(await ledger.entries(A));
      expect(account).toMatchObject(summed);
      expect(summed).toEqual({
        balance: 37.25,
        granted_total: 0.1,
        opening_total: 10.1,
        bought_total: 27.5,
        used_total: 0.45,
      });
    });

    it('keeps settings, finds an account by its App Store token, and forgets an account', async () => {
      const ledger = await make();
      await ledger.open(A, opening());
      await ledger.open(B, opening());
      await ledger.update(A, { refill: { pack: 'cf_credits_10' }, apple_account_token: 'tok-a' });
      expect(await ledger.get(A)).toMatchObject({
        refill: { pack: 'cf_credits_10' },
        apple_account_token: 'tok-a',
        balance: 3,
      });
      expect(await ledger.byAppleToken('tok-a')).toBe(A);
      expect(await ledger.byAppleToken('tok-b')).toBeUndefined();
      expect(
        await ledger.update('user_01NOBODY0000000000000000000', { refill: null }),
      ).toBeUndefined();
      await ledger.forget(A);
      expect(await ledger.get(A)).toBeUndefined();
      expect(await ledger.entries(A)).toEqual([]);
      expect(await ledger.owners()).toEqual([B]);
    });
  });
}
