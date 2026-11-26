import { createHash } from 'node:crypto';
import {
  Environment,
  type JWSTransactionDecodedPayload,
  NotificationTypeV2,
  SignedDataVerifier,
} from '@apple/app-store-server-library';
import { LOW_CREDITS, PACKS, PLANS } from '@cuttingfloor/plans';
import type { AccessCheck } from './access.ts';
import { APPLE_ROOT_CA_G3 } from './apple-root-ca.ts';
import type { Ledger } from './ledger.ts';

// Credits in the Cutting Floor AI iPhone app: what it shows (GET /v1/credits) and the packs it
// sells through the App Store, each cuttingfloor's own pack as `ai.cuttingfloor.app.<pack id>`.
// The app posts each StoreKit transaction (POST /v1/credits/apple) and App Store Server
// Notifications V2 report the same purchase (ONE_TIME_CHARGE) and any refund or revoke
// (POST /apple/notifications). Every signed payload is checked against Apple's root certificate.
// The transaction id is the entry's id (`apple:<id>`), so whichever arrives first counts. A
// purchase names its account by its appAccountToken, the UUID GET /v1/credits hands the app for
// that account (made from its WorkOS user id, or the one Kazi handed it at the split).

export const APPLE_BUNDLE_ID = 'ai.cuttingfloor.app';
export const APPLE_APP_ID = 6832958273;
/** Cutting Floor AI's App Store product ids are this and a pack id. */
export const APPLE_PRODUCT_PREFIX = `${APPLE_BUNDLE_ID}.`;

export interface ApplePack {
  product_id: string;
  credits: number;
}

/** The App Store packs: cuttingfloor's packs, by product id. */
export const APPLE_PACKS: ApplePack[] = PACKS.map((p) => ({
  product_id: APPLE_PRODUCT_PREFIX + p.id,
  credits: p.credits,
}));

/** A signed payload that failed Apple's checks, or a transaction we do not sell. */
export class AppleRejected extends Error {}

/** A transaction made for another account's appAccountToken. */
export class AppleOtherAccount extends Error {}

/** The account's appAccountToken when it has none yet: a UUID made from its WorkOS user id. */
export function appleTokenFor(owner: string): string {
  const h = createHash('sha256').update(`cuttingfloor apple account ${owner}`).digest('hex');
  // Shaped as a version 5 UUID, as StoreKit wants a UUID.
  const variant = ((Number.parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The entry an App Store purchase is, and its refund. */
export const appleEntryId = (transactionId: string) => `apple:${transactionId}`;
export const appleRefundId = (transactionId: string) => `apple-refund:${transactionId}`;

/** What the app shows (the mobile app's `Credits`). */
export interface AppCredits {
  /** Null on a given plan (no cap). */
  balance: number | null;
  unmetered: boolean;
  low: boolean;
  out: boolean;
  apple_products: ApplePack[];
  apple_account_token: string;
}

export interface ApplePurchase {
  transaction_id: string;
  original_transaction_id?: string;
  product_id: string;
  credits: number;
  /** Lowercase appAccountToken; undefined when the app set none. */
  account_token?: string;
  environment: string;
}

/** Checks a JWS against Apple's chain; a test hands in its own. */
export interface AppleVerifier {
  transaction(signed: string): Promise<JWSTransactionDecodedPayload>;
  notification(signed: string): Promise<{
    notificationType?: string;
    data?: { signedTransactionInfo?: string; environment?: string };
  }>;
}

/** The real check: Production and Sandbox both (App Review and TestFlight buy in Sandbox). */
export function appleVerifier(): AppleVerifier {
  const verifiers = new Map<Environment, SignedDataVerifier>();
  const verifier = (environment: Environment) => {
    let found = verifiers.get(environment);
    if (!found) {
      found = new SignedDataVerifier(
        [Buffer.from(APPLE_ROOT_CA_G3, 'base64')],
        true,
        environment,
        APPLE_BUNDLE_ID,
        APPLE_APP_ID,
      );
      verifiers.set(environment, found);
    }
    return found;
  };
  return {
    transaction: (signed) =>
      verified(verifier(claimed(signed, 'transaction')).verifyAndDecodeTransaction(signed)),
    notification: (signed) =>
      verified(verifier(claimed(signed, 'notification')).verifyAndDecodeNotification(signed)),
  };
}

/** The environment a JWS claims, read before verifying it so the matching verifier checks it. */
export function claimed(jws: string, path: 'transaction' | 'notification'): Environment {
  let payload: { environment?: unknown; data?: { environment?: unknown } };
  try {
    payload = JSON.parse(Buffer.from(jws.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    throw new AppleRejected('not a signed App Store payload');
  }
  const environment = path === 'transaction' ? payload?.environment : payload?.data?.environment;
  if (environment === Environment.PRODUCTION || environment === Environment.SANDBOX)
    return environment;
  throw new AppleRejected(`environment ${String(environment ?? 'missing')} is not accepted`);
}

async function verified<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof AppleRejected) throw error;
    throw new AppleRejected(`App Store signature check failed: ${(error as Error)?.message}`);
  }
}

/** The pack a verified transaction bought, or why it buys nothing. */
export function applePurchase(tx: JWSTransactionDecodedPayload): ApplePurchase {
  if (!tx.transactionId) throw new AppleRejected('transaction has no transactionId');
  const pack = APPLE_PACKS.find((p) => p.product_id === tx.productId);
  if (!pack) throw new AppleRejected(`unknown product ${tx.productId ?? '(none)'}`);
  return {
    transaction_id: tx.transactionId,
    ...(tx.originalTransactionId ? { original_transaction_id: tx.originalTransactionId } : {}),
    product_id: pack.product_id,
    credits: pack.credits,
    ...(tx.appAccountToken ? { account_token: tx.appAccountToken.toLowerCase() } : {}),
    environment: String(tx.environment),
  };
}

export class AppleCredits {
  readonly #ledger: Ledger;
  readonly #access: AccessCheck;
  readonly #verify: AppleVerifier;

  constructor(options: { ledger: Ledger; access: AccessCheck; verifier?: AppleVerifier }) {
    this.#ledger = options.ledger;
    this.#access = options.access;
    this.#verify = options.verifier ?? appleVerifier();
  }

  /** The account's appAccountToken, kept on its ledger account the first time it is asked for. */
  async token(owner: string): Promise<string> {
    const account = await this.#access.creditAccount(owner);
    if (account.apple_account_token) return account.apple_account_token;
    const token = appleTokenFor(owner);
    await this.#ledger.update(owner, { apple_account_token: token });
    return token;
  }

  /** What the app shows: the balance, whether it runs low or out, the packs and the token. */
  async credits(owner: string): Promise<AppCredits> {
    const access = await this.#access.require(owner);
    const metered = PLANS[access.plan].credits.kind === 'balance';
    const balance = metered ? (await this.#access.balance(owner, access)).left : null;
    return {
      balance,
      unmetered: !metered,
      low: balance !== null && balance < LOW_CREDITS,
      out: balance !== null && balance <= 0,
      apple_products: APPLE_PACKS,
      apple_account_token: await this.token(owner),
    };
  }

  /**
   * Records a transaction the app posts, on the signed-in account it was made for. Answers the
   * credits it added (0 when it was counted before) and the balance.
   */
  async purchase(
    owner: string,
    signed: string,
  ): Promise<{ credits_added: number; balance: number | null }> {
    const tx = await this.#verify.transaction(signed);
    if (tx.revocationDate) throw new AppleRejected('transaction was revoked');
    const purchase = applePurchase(tx);
    if (purchase.account_token !== (await this.token(owner)))
      throw new AppleOtherAccount('transaction is for another account');
    const written = await this.#record(owner, purchase);
    this.#access.forget(owner);
    const { balance } = await this.credits(owner);
    return { credits_added: written.duplicate ? 0 : purchase.credits, balance };
  }

  async #record(owner: string, purchase: ApplePurchase) {
    const written = await this.#ledger.credit(owner, {
      id: appleEntryId(purchase.transaction_id),
      kind: 'purchase',
      credits: purchase.credits,
      pack: purchase.product_id.slice(APPLE_PRODUCT_PREFIX.length),
      reason: `App Store ${purchase.environment}${purchase.original_transaction_id ? `, original ${purchase.original_transaction_id}` : ''}`,
    });
    process.stderr.write(
      `credits: apple ${purchase.transaction_id} ${purchase.product_id} (${purchase.environment}) +${purchase.credits} → ${owner} balance=${written.account.balance}${written.duplicate ? ' (duplicate)' : ''}\n`,
    );
    return written;
  }

  /** One App Store Server Notification V2: charges and refunds move a balance; others are ignored. */
  async notification(signedPayload: string): Promise<string> {
    const notification = await this.#verify.notification(signedPayload);
    const type = String(notification.notificationType);
    const handled: string[] = [
      NotificationTypeV2.ONE_TIME_CHARGE,
      NotificationTypeV2.REFUND,
      NotificationTypeV2.REVOKE,
    ];
    if (!handled.includes(type)) return `ignored ${type}`;
    const signed = notification.data?.signedTransactionInfo;
    if (!signed) return `ignored ${type}: no transaction`;
    const tx = await this.#verify.transaction(signed);
    if (!APPLE_PACKS.some((p) => p.product_id === tx.productId))
      return `ignored ${type}: product ${tx.productId}`;
    const purchase = applePurchase(tx);
    if (type === NotificationTypeV2.ONE_TIME_CHARGE) {
      if (tx.revocationDate) return `ignored ${type}: revoked`;
      const owner = purchase.account_token
        ? await this.#ledger.byAppleToken(purchase.account_token)
        : undefined;
      // The app's own post records it once it knows the account.
      if (!owner) return `ignored ${type}: no account has its appAccountToken`;
      await this.#record(owner, purchase);
      this.#access.forget(owner);
      return `${type} ${purchase.transaction_id}`;
    }
    const bought = await this.#ledger.findEntry(appleEntryId(purchase.transaction_id));
    if (!bought) return `ignored ${type}: no purchase recorded, nothing to take back`;
    const taken = await this.#ledger.credit(bought.owner, {
      id: appleRefundId(purchase.transaction_id),
      kind: 'refund',
      credits: -bought.credits,
      ...(bought.pack ? { pack: bought.pack } : {}),
      reason: `App Store ${type}`,
    });
    this.#access.forget(bought.owner);
    process.stderr.write(
      `credits: apple ${type} ${purchase.transaction_id} -${bought.credits} → ${bought.owner} balance=${taken.account.balance}${taken.duplicate ? ' (duplicate)' : ''}\n`,
    );
    return `${type} ${purchase.transaction_id}`;
  }
}
