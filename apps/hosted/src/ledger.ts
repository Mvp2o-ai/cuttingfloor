import { type Collection, defineCollection, type Records } from '@cuttingfloor/core';
import type { ClientSession, Db, Collection as MongoCollection } from 'mongodb';

// cuttingfloor's credit ledger: one balance per account (its WorkOS user id), spent only on
// cuttingfloor. Kazi keeps its own credits; nothing is shared but the sign-in.
//
// Every change is an entry, and an entry's id is its idempotency key within the account: a grant
// (`grant:activation`), the balance carried over from Kazi's ledger at the split
// (`opening:<Kazi account id>`) or from before any ledger (`opening:carry`), a pack bought
// (`pi_…`, the payment intent), a refund (`re_…`), a spend (`<job id>-release`) or an
// adjustment by hand. Writing an entry that is there already changes nothing and answers what the
// account holds. An account's balance and totals are kept beside its entries, written in the same
// transaction, and can always be worked out again from the entries alone (`totals`). A spend never
// takes the balance below zero; a refund of credits already spent can.
//
// MongoDB keeps it on a hosted server (`credit_accounts`, `credit_entries`, in the record
// database), with transactions. The filesystem store keeps it for tests and a single server: the
// entries are the record and the totals are summed from them, one write at a time per account.

export type EntryKind = 'grant' | 'opening' | 'purchase' | 'refund' | 'spend' | 'adjust';

/** An account's credits, as the ledger keeps them. */
export interface CreditAccount {
  /** The WorkOS user id. */
  owner: string;
  balance: number;
  /** Credits given: the activation grant, adjustments. */
  granted_total: number;
  /** Credits carried over, signed: from Kazi's ledger at the split, or from before any ledger. */
  opening_total: number;
  /** Credits bought in packs, less refunds. */
  bought_total: number;
  /** Credits spent here. */
  used_total: number;
  /** Credits used before this ledger (counted elsewhere), so what was used shows in full. */
  used_before: number;
  /** The pack bought on its own when the balance runs low, or null for off. */
  refill: { pack: string } | null;
  /** The Stripe customer last seen for the account. */
  stripe_customer_id: string | null;
  /** The StoreKit appAccountToken the account's App Store purchases carry, once handed out. */
  apple_account_token: string | null;
  created_at: string;
}

export interface CreditEntry {
  /** The idempotency key, unique within the account. */
  id: string;
  owner: string;
  kind: EntryKind;
  /** Signed: what the entry adds to the balance. */
  credits: number;
  at: string;
  /** The balance after it. */
  balance: number;
  /** What spent it (`export.release`). */
  tool?: string;
  /** The pack a purchase or refund was for. */
  pack?: string;
  payment_intent?: string;
  /** Why, for an adjustment or a carry-over. */
  reason?: string;
  /** Who made an adjustment: the admin's WorkOS user id. */
  by?: string;
}

/** An entry to write: `at` defaults to now. */
export type NewEntry = Omit<CreditEntry, 'owner' | 'balance' | 'at'> & { at?: string };

/** What a spend did: the balance after, and the line it took the balance across. */
export interface Spend {
  balance: number;
  /** The same id was spent before; nothing changed. */
  duplicate: boolean;
  /** Below LOW_CREDITS, or to zero (or below), from above it. */
  crossed: 'low' | 'out' | null;
}

/** A new account: what it used before, and the entries it opens with. */
export interface Opening {
  used_before: number;
  stripe_customer_id?: string | null;
  refill?: { pack: string } | null;
  apple_account_token?: string | null;
  entries: NewEntry[];
}

/** The settings an account keeps beside its balance. */
export type AccountSettings = Partial<
  Pick<CreditAccount, 'refill' | 'stripe_customer_id' | 'used_before' | 'apple_account_token'>
>;

/** A spend the balance can't cover. Nothing was written. */
export class Insufficient extends Error {
  readonly balance: number;
  constructor(balance: number) {
    super(`the balance is ${balance}`);
    this.balance = balance;
  }
}

/** The ledger has no account for this owner: open it first. */
export class NoCreditAccount extends Error {}

export interface Ledger {
  /** The account, or undefined when it was never opened. */
  get(owner: string): Promise<CreditAccount | undefined>;
  /**
   * The account, opened the first time with what `opening` says (called only then). Of opens at
   * the same moment one stands, with its entries; the others answer it.
   */
  open(owner: string, opening: () => Promise<Opening>): Promise<CreditAccount>;
  /** Spends `credits` once under `id`. Throws Insufficient when the balance can't cover it. */
  spend(owner: string, entry: { id: string; credits: number; tool: string }): Promise<Spend>;
  /**
   * Writes an entry once, as it is: a grant, opening, purchase, refund or adjustment, or a spend
   * that already happened elsewhere (a release Kazi's ledger took before the split), which no
   * balance can refuse. A release here spends through spend(), which can.
   */
  credit(
    owner: string,
    entry: NewEntry,
  ): Promise<{ account: CreditAccount; duplicate: boolean; entry: CreditEntry }>;
  /** Changes an account's settings; undefined when there is no account. */
  update(owner: string, settings: AccountSettings): Promise<CreditAccount | undefined>;
  /** Every entry of the account, oldest first. */
  entries(owner: string): Promise<CreditEntry[]>;
  /** An entry by its id, in whichever account has it (an App Store refund finds its purchase). */
  findEntry(id: string): Promise<CreditEntry | undefined>;
  /** The account whose App Store purchases carry this appAccountToken. */
  byAppleToken(token: string): Promise<string | undefined>;
  /** Every account's owner. */
  owners(): Promise<string[]>;
  /** Removes the account and its entries (the account was deleted). */
  forget(owner: string): Promise<void>;
}

/** Below this balance a spend crosses `low`; at zero, `out`. LOW_CREDITS, passed in by its owner. */
export function crossing(before: number, after: number, low: number): Spend['crossed'] {
  if (before > 0 && after <= 0) return 'out';
  if (before >= low && after < low) return 'low';
  return null;
}

/** What an account's balance and totals are, from its entries alone. */
export function totals(entries: readonly Pick<CreditEntry, 'kind' | 'credits'>[]) {
  const sum = { balance: 0, granted_total: 0, opening_total: 0, bought_total: 0, used_total: 0 };
  for (const e of entries) {
    for (const [field, by] of Object.entries(moves(e.kind, e.credits)))
      sum[field as keyof typeof sum] = round(sum[field as keyof typeof sum] + by);
  }
  return sum;
}

/** The fields an entry moves, and by how much. */
function moves(kind: EntryKind, credits: number): Record<string, number> {
  const total =
    kind === 'grant' || kind === 'adjust'
      ? 'granted_total'
      : kind === 'opening'
        ? 'opening_total'
        : kind === 'spend'
          ? 'used_total'
          : 'bought_total';
  return { balance: credits, [total]: kind === 'spend' ? -credits : credits };
}

/** Kept to six places, so sums of quarter credits and refund shares stay exact enough to compare. */
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const KINDS = new Set<EntryKind>(['grant', 'opening', 'purchase', 'refund', 'spend', 'adjust']);

function check(owner: string, entry: Pick<NewEntry, 'id' | 'kind' | 'credits'>): void {
  if (!/^user_[0-9A-Z]{26}$/.test(owner)) throw new Error(`not an account: ${owner}`);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,199}$/.test(entry.id))
    throw new Error(`not an entry id: ${entry.id}`);
  if (!KINDS.has(entry.kind)) throw new Error(`not an entry kind: ${entry.kind}`);
  if (!Number.isFinite(entry.credits)) throw new Error(`credits must be a number: ${entry.id}`);
  if (entry.kind === 'spend' && !(entry.credits < 0)) throw new Error('a spend takes credits');
}

const blank = (owner: string, opening: Opening, now: string): CreditAccount => ({
  owner,
  balance: 0,
  granted_total: 0,
  opening_total: 0,
  bought_total: 0,
  used_total: 0,
  used_before: round(opening.used_before),
  refill: opening.refill ?? null,
  stripe_customer_id: opening.stripe_customer_id ?? null,
  apple_account_token: opening.apple_account_token ?? null,
  created_at: now,
});

// MongoDB: one document per account, `_id` the owner; one per entry, `_id` `{owner}/{id}`.

type AccountDoc = Omit<CreditAccount, 'owner'> & { _id: string; updated_at: string };
type EntryDoc = CreditEntry & { _id: string };

const ACCOUNTS = 'credit_accounts';
const ENTRIES = 'credit_entries';

export class MongoLedger implements Ledger {
  readonly #db: () => Promise<Db>;
  readonly #low: number;
  #ready: Promise<void> | undefined;

  /** `db`: the record database (MongoRecords.database). `low`: LOW_CREDITS. */
  constructor(options: { db: () => Promise<Db>; low: number }) {
    this.#db = options.db;
    this.#low = options.low;
  }

  async #cols(): Promise<{
    db: Db;
    accounts: MongoCollection<AccountDoc>;
    entries: MongoCollection<EntryDoc>;
  }> {
    const db = await this.#db();
    const accounts = db.collection<AccountDoc>(ACCOUNTS);
    const entries = db.collection<EntryDoc>(ENTRIES);
    this.#ready ??= Promise.all([
      entries.createIndex({ owner: 1, at: 1 }, { name: 'owner_at' }),
      entries.createIndex({ id: 1 }, { name: 'id' }),
      accounts.createIndex(
        { apple_account_token: 1 },
        {
          name: 'apple_account_token',
          unique: true,
          partialFilterExpression: { apple_account_token: { $type: 'string' } },
        },
      ),
    ])
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#ready = undefined;
        throw error;
      });
    await this.#ready;
    return { db, accounts, entries };
  }

  /** Runs `work` in one transaction, tried again by the driver on a write conflict. */
  async #transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const { db } = await this.#cols();
    const session = db.client.startSession();
    try {
      let out: T | undefined;
      await session.withTransaction(
        async () => {
          out = await work(session);
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
      return out as T;
    } finally {
      await session.endSession();
    }
  }

  async get(owner: string): Promise<CreditAccount | undefined> {
    const { accounts } = await this.#cols();
    const doc = await accounts.findOne({ _id: owner });
    return doc ? fromDoc(doc) : undefined;
  }

  async open(owner: string, opening: () => Promise<Opening>): Promise<CreditAccount> {
    const known = await this.get(owner);
    if (known) return known;
    const plan = await opening();
    for (const e of plan.entries) check(owner, e);
    const now = new Date().toISOString();
    const { _id: _, ...fresh } = toDoc(blank(owner, plan, now), now);
    try {
      await this.#transaction(async (session) => {
        const { accounts } = await this.#cols();
        await accounts.insertOne({ _id: owner, ...fresh }, { session });
        for (const e of plan.entries) await this.#write(session, owner, e, now);
      });
    } catch (error) {
      // Opened at the same moment by another call: that one stands.
      if (!duplicateKey(error)) throw error;
    }
    const opened = await this.get(owner);
    if (!opened) throw new NoCreditAccount(owner);
    return opened;
  }

  async spend(owner: string, entry: { id: string; credits: number; tool: string }): Promise<Spend> {
    const credits = round(entry.credits);
    check(owner, { id: entry.id, kind: 'spend', credits: -credits });
    try {
      return await this.#transaction(async (session) => {
        const { accounts, entries } = await this.#cols();
        const prior = await entries.findOne({ _id: key(owner, entry.id) }, { session });
        if (prior) return { ...(await this.#balance(session, owner)), duplicate: true };
        const after = await accounts.findOneAndUpdate(
          { _id: owner, balance: { $gte: credits - 1e-9 } },
          change(moves('spend', -credits)),
          { session, returnDocument: 'after' },
        );
        if (!after) {
          const now = await accounts.findOne({ _id: owner }, { session });
          if (!now) throw new NoCreditAccount(owner);
          throw new Insufficient(now.balance);
        }
        await entries.insertOne(
          {
            _id: key(owner, entry.id),
            id: entry.id,
            owner,
            kind: 'spend',
            credits: -credits,
            at: new Date().toISOString(),
            balance: after.balance,
            tool: entry.tool,
          },
          { session },
        );
        return {
          balance: after.balance,
          duplicate: false,
          crossed: crossing(round(after.balance + credits), after.balance, this.#low),
        };
      });
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      const account = await this.get(owner);
      return { balance: account?.balance ?? 0, duplicate: true, crossed: null };
    }
  }

  async #balance(session: ClientSession, owner: string) {
    const { accounts } = await this.#cols();
    const doc = await accounts.findOne({ _id: owner }, { session });
    return { balance: doc?.balance ?? 0, crossed: null };
  }

  async credit(
    owner: string,
    entry: NewEntry,
  ): Promise<{ account: CreditAccount; duplicate: boolean; entry: CreditEntry }> {
    check(owner, entry);
    try {
      return await this.#transaction(async (session) => {
        const { accounts, entries } = await this.#cols();
        const prior = await entries.findOne({ _id: key(owner, entry.id) }, { session });
        const doc = prior ? await accounts.findOne({ _id: owner }, { session }) : undefined;
        if (prior && doc)
          return { account: fromDoc(doc), duplicate: true, entry: fromEntry(prior) };
        const written = await this.#write(session, owner, entry, new Date().toISOString());
        return { ...written, duplicate: false };
      });
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      return this.#stored(owner, entry.id);
    }
  }

  async #stored(owner: string, id: string) {
    const { entries } = await this.#cols();
    const [account, prior] = await Promise.all([
      this.get(owner),
      entries.findOne({ _id: key(owner, id) }),
    ]);
    if (!account || !prior) throw new NoCreditAccount(owner);
    return { account, duplicate: true, entry: fromEntry(prior) };
  }

  /** One entry and its account's totals, in the caller's transaction. */
  async #write(session: ClientSession, owner: string, entry: NewEntry, now: string) {
    const { accounts, entries } = await this.#cols();
    const credits = round(entry.credits);
    const after = await accounts.findOneAndUpdate(
      { _id: owner },
      change(moves(entry.kind, credits)),
      { session, returnDocument: 'after' },
    );
    if (!after) throw new NoCreditAccount(owner);
    const { at, ...rest } = entry;
    const written: CreditEntry = {
      ...rest,
      owner,
      credits,
      at: at ?? now,
      balance: after.balance,
    };
    await entries.insertOne({ _id: key(owner, entry.id), ...written }, { session });
    return { account: fromDoc(after), entry: written };
  }

  async update(owner: string, settings: AccountSettings): Promise<CreditAccount | undefined> {
    const { accounts } = await this.#cols();
    const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (settings.refill !== undefined) set.refill = settings.refill;
    if (settings.stripe_customer_id !== undefined)
      set.stripe_customer_id = settings.stripe_customer_id;
    if (settings.used_before !== undefined) set.used_before = round(settings.used_before);
    if (settings.apple_account_token !== undefined)
      set.apple_account_token = settings.apple_account_token;
    const after = await accounts.findOneAndUpdate(
      { _id: owner },
      { $set: set },
      { returnDocument: 'after' },
    );
    return after ? fromDoc(after) : undefined;
  }

  async entries(owner: string): Promise<CreditEntry[]> {
    const { entries } = await this.#cols();
    const docs = await entries.find({ owner }).sort({ at: 1, _id: 1 }).toArray();
    return docs.map(fromEntry);
  }

  async findEntry(id: string): Promise<CreditEntry | undefined> {
    const { entries } = await this.#cols();
    const doc = await entries.findOne({ id });
    return doc ? fromEntry(doc) : undefined;
  }

  async byAppleToken(token: string): Promise<string | undefined> {
    const { accounts } = await this.#cols();
    return (await accounts.findOne({ apple_account_token: token }, { projection: { _id: 1 } }))
      ?._id;
  }

  async owners(): Promise<string[]> {
    const { accounts } = await this.#cols();
    return (await accounts.find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
  }

  async forget(owner: string): Promise<void> {
    await this.#transaction(async (session) => {
      const { accounts, entries } = await this.#cols();
      await entries.deleteMany({ owner }, { session });
      await accounts.deleteOne({ _id: owner }, { session });
    });
  }
}

const key = (owner: string, id: string) => `${owner}/${id}`;

/** An update that adds to numbers, rounded as it goes, and marks the account written. */
function change(by: Record<string, number>) {
  const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [field, n] of Object.entries(by))
    set[field] = { $round: [{ $add: [{ $ifNull: [`$${field}`, 0] }, n] }, 6] };
  return [{ $set: set }];
}

function toDoc(account: CreditAccount, now: string): AccountDoc {
  const { owner, ...rest } = account;
  return { _id: owner, ...rest, updated_at: now };
}

function fromDoc(doc: AccountDoc): CreditAccount {
  return {
    owner: doc._id,
    balance: doc.balance,
    granted_total: doc.granted_total,
    opening_total: doc.opening_total,
    bought_total: doc.bought_total,
    used_total: doc.used_total,
    used_before: doc.used_before ?? 0,
    refill: doc.refill ?? null,
    stripe_customer_id: doc.stripe_customer_id ?? null,
    apple_account_token: doc.apple_account_token ?? null,
    created_at: doc.created_at,
  };
}

function fromEntry(doc: EntryDoc): CreditEntry {
  const { _id: _, ...entry } = doc;
  return entry;
}

function duplicateKey(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 11000;
}

// The filesystem store: entries as records under the account's folder (`credits/{id}.json`), the
// settings as one record (`credits.json`). Totals are summed from the entries on every read.

interface FileAccount extends AccountSettings {
  created_at: string;
}

export class FileLedger implements Ledger {
  readonly #records: Records;
  readonly #low: number;
  readonly #accounts;
  readonly #entries;
  /** One write at a time per account: this store serves one server. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: { records: Records; low: number }) {
    this.#records = options.records;
    this.#low = options.low;
    // Defined here, not as the module loads: a database store would otherwise make collections
    // of these names for records MongoLedger keeps in its own shape.
    this.#accounts = defineCollection<FileAccount>({
      name: 'credit_accounts',
      scope: 'owner',
      fs: { dir: '' },
    });
    this.#entries = defineCollection<CreditEntry>({
      name: 'credit_entries',
      scope: 'owner',
      fs: { dir: 'credits' },
    });
  }

  #settings(owner: string): Collection<FileAccount> {
    return this.#records.collection(this.#accounts, { owner });
  }

  #entryRecords(owner: string): Collection<CreditEntry> {
    return this.#records.collection(this.#entries, { owner });
  }

  #alone<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const before = this.#queues.get(owner) ?? Promise.resolve();
    const next = before.then(work, work);
    const settled = next.catch(() => undefined);
    this.#queues.set(owner, settled);
    void settled.then(() => {
      if (this.#queues.get(owner) === settled) this.#queues.delete(owner);
    });
    return next;
  }

  async get(owner: string): Promise<CreditAccount | undefined> {
    const settings = await this.#settings(owner).get('credits');
    if (!settings) return undefined;
    const entries = await this.entries(owner);
    return {
      owner,
      ...totals(entries),
      used_before: settings.used_before ?? 0,
      refill: settings.refill ?? null,
      stripe_customer_id: settings.stripe_customer_id ?? null,
      apple_account_token: settings.apple_account_token ?? null,
      created_at: settings.created_at,
    };
  }

  async open(owner: string, opening: () => Promise<Opening>): Promise<CreditAccount> {
    const known = await this.get(owner);
    if (known) return known;
    const plan = await opening();
    for (const e of plan.entries) check(owner, e);
    await this.#alone(owner, async () => {
      if (await this.#settings(owner).has('credits')) return;
      const now = new Date().toISOString();
      // Entries first: the settings record is what says the account is open.
      let balance = 0;
      for (const e of plan.entries) {
        balance = round(balance + e.credits);
        const { at, ...rest } = e;
        await this.#entryRecords(owner).insertOnce(e.id, {
          ...rest,
          owner,
          credits: round(e.credits),
          at: at ?? now,
          balance,
        });
      }
      const { owner: _, ...account } = blank(owner, plan, now);
      await this.#settings(owner).insertOnce('credits', {
        created_at: account.created_at,
        used_before: account.used_before,
        refill: account.refill,
        stripe_customer_id: account.stripe_customer_id,
        apple_account_token: account.apple_account_token,
      });
    });
    const opened = await this.get(owner);
    if (!opened) throw new NoCreditAccount(owner);
    return opened;
  }

  async spend(owner: string, entry: { id: string; credits: number; tool: string }): Promise<Spend> {
    const credits = round(entry.credits);
    check(owner, { id: entry.id, kind: 'spend', credits: -credits });
    return this.#alone(owner, async () => {
      const account = await this.get(owner);
      if (!account) throw new NoCreditAccount(owner);
      if (await this.#entryRecords(owner).has(entry.id))
        return { balance: account.balance, duplicate: true, crossed: null };
      if (account.balance < credits - 1e-9) throw new Insufficient(account.balance);
      const balance = round(account.balance - credits);
      await this.#entryRecords(owner).insertOnce(entry.id, {
        id: entry.id,
        owner,
        kind: 'spend',
        credits: -credits,
        at: new Date().toISOString(),
        balance,
        tool: entry.tool,
      });
      return {
        balance,
        duplicate: false,
        crossed: crossing(account.balance, balance, this.#low),
      };
    });
  }

  async credit(
    owner: string,
    entry: NewEntry,
  ): Promise<{ account: CreditAccount; duplicate: boolean; entry: CreditEntry }> {
    check(owner, entry);
    return this.#alone(owner, async () => {
      const account = await this.get(owner);
      if (!account) throw new NoCreditAccount(owner);
      const prior = await this.#entryRecords(owner).get(entry.id);
      if (prior) return { account, duplicate: true, entry: prior };
      const credits = round(entry.credits);
      const { at, ...rest } = entry;
      const written: CreditEntry = {
        ...rest,
        owner,
        credits,
        at: at ?? new Date().toISOString(),
        balance: round(account.balance + credits),
      };
      await this.#entryRecords(owner).insertOnce(entry.id, written);
      const after = await this.get(owner);
      if (!after) throw new NoCreditAccount(owner);
      return { account: after, duplicate: false, entry: written };
    });
  }

  async update(owner: string, settings: AccountSettings): Promise<CreditAccount | undefined> {
    const changed = await this.#alone(owner, async () => {
      const known = await this.#settings(owner).get('credits');
      if (!known) return false;
      const next: FileAccount = { ...known };
      if (settings.refill !== undefined) next.refill = settings.refill;
      if (settings.stripe_customer_id !== undefined)
        next.stripe_customer_id = settings.stripe_customer_id;
      if (settings.used_before !== undefined) next.used_before = round(settings.used_before);
      if (settings.apple_account_token !== undefined)
        next.apple_account_token = settings.apple_account_token;
      await this.#settings(owner).put('credits', next);
      return true;
    });
    return changed ? this.get(owner) : undefined;
  }

  async entries(owner: string): Promise<CreditEntry[]> {
    const found = await this.#entryRecords(owner).find();
    return found
      .map((r) => r.value)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  async findEntry(id: string): Promise<CreditEntry | undefined> {
    for (const owner of await this.owners()) {
      const found = await this.#entryRecords(owner).get(id);
      if (found) return found;
    }
    return undefined;
  }

  async byAppleToken(token: string): Promise<string | undefined> {
    for (const owner of await this.owners())
      if ((await this.#settings(owner).get('credits'))?.apple_account_token === token) return owner;
    return undefined;
  }

  async owners(): Promise<string[]> {
    const out: string[] = [];
    for (const owner of await this.#records.owners())
      if (/^user_[0-9A-Z]{26}$/.test(owner) && (await this.#settings(owner).has('credits')))
        out.push(owner);
    return out;
  }

  async forget(owner: string): Promise<void> {
    await this.#alone(owner, async () => {
      await this.#entryRecords(owner).clear();
      await this.#settings(owner).delete('credits');
    });
  }
}
