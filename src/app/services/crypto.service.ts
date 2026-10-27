import { Injectable } from '@angular/core';
import { x25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import canonicalize from 'canonicalize';
import { combine, split } from 'shamir-secret-sharing';
import { Bytes, toBuffer } from './passkey.service';

// --- the masterpod side (the keyholder test app's crypto.service.ts) ---------

/** A keyholder's hybrid public key as /get-keyholder-public-key answers it: X25519 (32 bytes) and ML-KEM-1024 (1568 bytes), hex. */
export interface HybridPublicKey {
  x25519: string;
  mlkem: string;
}

/** A key pair of either signature algorithm; secret material stays in memory only. */
export interface SigningKey {
  algorithm: KeyAlgorithm;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export type KeyAlgorithm = 'P-256' | 'ML-DSA-87';

/** The ephemeral session keys: fresh P-256 and ML-DSA-87 pairs at every create and unlock. */
export interface SessionKeys {
  ecdsa: SigningKey;
  mldsa: SigningKey;
}

/** Both signatures over one payload, hex: the pod envelope's and the account envelope's. */
export interface Signatures {
  ecdsa: string;
  mldsa: string;
}

/** A signed envelope: the payload and its two signatures. */
export interface Envelope {
  payload: Record<string, unknown>;
  signatures: Signatures;
}

/**
 * The chat key pair of the masterpod spec section 7: a P-256 scalar and an
 * ML-KEM-1024 seed (the 96 bytes inside chatPrivateKeyBlob) with the keys
 * derived from them. kemSecret is the expanded decapsulation key, kept so
 * unwrapping a room key does not re-run keygen.
 */
export interface ChatKeys {
  p256Secret: Uint8Array;
  kemSeed: Uint8Array;
  p256Public: Uint8Array;
  kemPublic: Uint8Array;
  kemSecret: Uint8Array;
}

/** The two public keys the backup code derives; the server stores them for recovery later. */
export interface BackupCodeKeys {
  p256Public: Uint8Array;
  mldsaPublic: Uint8Array;
}

/**
 * The recovery hybrid pair of masterpod spec 12.6: an X25519 secret and an
 * ML-KEM-1024 seed (the 96 bytes inside hybridKeyBlob) with the keys derived
 * from them, the shape of the keyholders' receiving keys. The public halves
 * are the case's hybridKey; the bankers encrypt shares to them. kemSecret is
 * the expanded decapsulation key, kept so opening a share does not re-run
 * keygen.
 */
export interface HybridKeys {
  x25519Secret: Uint8Array;
  kemSeed: Uint8Array;
  x25519Public: Uint8Array;
  kemPublic: Uint8Array;
  kemSecret: Uint8Array;
}

// --- the anos side (the anos test app's crypto.service.ts) ------------------

/** The eight key roles of a create-account transaction, in schema order. */
export const KEY_ROLES = [
  'key1',
  'postQuantumKey1',
  'key2',
  'postQuantumKey2',
  'breakGlassKey',
  'breakGlassPostQuantumKey',
  'walletKey',
  'walletPostQuantumKey',
] as const;

export type KeyRole = (typeof KEY_ROLES)[number];

/** The six roles the browser holds keys for; the wallet pair is the signing server's. */
export const BROWSER_KEY_ROLES = KEY_ROLES.filter((role) => !role.startsWith('wallet')) as readonly BrowserKeyRole[];

export type BrowserKeyRole = Exclude<KeyRole, 'walletKey' | 'walletPostQuantumKey'>;

/** One signing key per browser-held role. Secret material stays in memory only. */
export type BrowserAccountKeys = Record<BrowserKeyRole, SigningKey>;

/** The wallet pair's public keys as /api/sign/public-keys answers them, hex. */
export interface WalletPublicKeys {
  walletKey: string;
  walletPostQuantumKey: string;
}

/** The account types the wallet can create; the validators store one as accounts.type. */
export const ACCOUNT_TYPES = ['spending', 'guarded', 'vault', 'assisted'] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export interface CreateAccountPayload {
  accountId: string;
  accountType: AccountType;
  createdAt: string;
  transactionId: string;
  transactionType: 'accountCreation';
  publicKeys: Record<KeyRole, string>;
}

/** A creation as the browser builds it (six signatures) and as /api/sign returns it (eight). */
export interface CreateAccountTransaction {
  payload: CreateAccountPayload;
  signatures: Partial<Record<KeyRole, string>>;
}

/**
 * The secret halves of pair one and pair two, the 128 bytes inside keyBlob:
 * key1 scalar (32) || postQuantumKey1 seed (32) || key2 scalar (32) ||
 * postQuantumKey2 seed (32). The public keys come back from them.
 */
export interface AccountSecrets {
  key1Scalar: Uint8Array;
  postQuantumKey1Seed: Uint8Array;
  key2Scalar: Uint8Array;
  postQuantumKey2Seed: Uint8Array;
}

/** Pair one and pair two as signing keys. */
export type PairKeys = Pick<BrowserAccountKeys, 'key1' | 'postQuantumKey1' | 'key2' | 'postQuantumKey2'>;

/** Pair one alone: what signs every transfer, follow-up, proposal and read. */
export type PairOne = Pick<BrowserAccountKeys, 'key1' | 'postQuantumKey1'>;

/** The two break-glass keys, from the break-glass seed. */
export type BreakGlassKeys = Pick<BrowserAccountKeys, 'breakGlassKey' | 'breakGlassPostQuantumKey'>;

/** The roles the browser signs a transfer or a follow-up with: pair one. The signing server adds the wallet pair. */
export const PAIR_ONE_ROLES = ['key1', 'postQuantumKey1'] as const;

/** Signatures over a payload's canonical bytes: pair one from the browser, the wallet pair from /api/sign. */
export type TransferSignatures = Partial<Record<'key1' | 'postQuantumKey1' | 'walletKey' | 'walletPostQuantumKey', string>>;

/** The five transfer types. */
export type TransferType = 'anosTransfer' | 'guardedAnosTransfer' | 'vaultAnosTransfer' | 'assistedAnosTransfer' | 'escrowTransfer';

export interface AnosTransferPayload {
  accountId: string;
  transactionId: string;
  previousTransactionId: string;
  transactionType: TransferType;
  /** Millionths of a unit as a decimal string, since JSON has no safe big integer. */
  amount: string;
  accountIdTo: string;
  createdAt: string;
}

export interface AnosTransferTransaction {
  payload: AnosTransferPayload;
  signatures: TransferSignatures;
}

/** The fund's account id: the SHA-256 of "anosFund", the genesis fund account every validator ships with. */
export const FUND_ACCOUNT_ID = 'b8f8da9cc80161e0705943de93dedfe850f0cab74b1939df806972df6ef61e24';

/** The six purposes anos may be staked for, as the validators' stakeFor names them. */
export const STAKE_PURPOSES = ['daoVote', 'moderator', 'attestor', 'guardian', 'validator', 'masterPod'] as const;

export type StakePurpose = (typeof STAKE_PURPOSES)[number];

export interface TransferToFundPayload extends Omit<AnosTransferPayload, 'transactionType'> {
  transactionType: 'transferToFund';
  stakeFor: StakePurpose;
}

export interface TransferToFundTransaction {
  payload: TransferToFundPayload;
  signatures: TransferSignatures;
}

/** One payment of a fund proposal; stakeFor marks a payout that returns stake. */
export interface Payout {
  accountIdTo: string;
  amount: string;
  reason: string;
  stakeFor?: StakePurpose;
}

/** A guardian's list of payments from the fund. No previousTransactionId: the fund cannot sign. */
export interface FundProposalPayload {
  accountId: string;
  guardianId: string;
  transactionType: 'fundProposal';
  createdAt: string;
  payouts: Payout[];
  transactionId: string;
}

export interface FundProposalTransaction {
  payload: FundProposalPayload;
  signatures: TransferSignatures;
}

/** The follow-ups: signed objects attached to a transaction a validator holds. */
export interface AttestationPayload {
  type: 'attestation';
  transactionId: string;
  accountId: string;
  attestorId: string;
}

export interface AssistedTransferCancelPayload {
  type: 'assistedTransferCancel';
  transactionId: string;
  accountId: string;
}

export type Vote = 'for' | 'against';

export interface GuardianVotePayload {
  type: 'guardianVote';
  transactionId: string;
  guardianId: string;
  vote: Vote;
}

export type EscrowSignatureType = 'escrowSuccess' | 'escrowCancel' | 'escrowDispute';

export interface EscrowSignaturePayload {
  type: EscrowSignatureType;
  transactionId: string;
  accountId: string;
}

export type Verdict = 'success' | 'cancel';

export interface EscrowVerdictPayload {
  type: 'escrowVerdict';
  transactionId: string;
  arbitratorId: string;
  verdict: Verdict;
}

export type FollowUpPayload =
  | AttestationPayload
  | AssistedTransferCancelPayload
  | GuardianVotePayload
  | EscrowSignaturePayload
  | EscrowVerdictPayload;

/** A follow-up as sent: its payload with signedAt added, signed by pair one here and the wallet pair at /api/sign. */
export interface FollowUp<T extends FollowUpPayload = FollowUpPayload> {
  payload: T & { signedAt: string };
  signatures: TransferSignatures;
}

/** Anything /api/sign takes and gives back: a payload and a signatures object. */
export interface SignedObject {
  payload: object;
  signatures: Record<string, string | undefined>;
}

/**
 * A moderator's sign-off on a recovery case (masterpod spec 12.6): what pair
 * one of an anos account in the moderator's pod signs, as RFC 8785 canonical
 * JSON. The masterpod verifies it against the account's stored creation.
 */
export interface SignOffMessage {
  caseId: string;
  accountId: string;
  verdict: 'approve' | 'reject';
  note: string;
  signedAt: string;
}

// --- constants ----------------------------------------------------------------

/** AES-256-GCM everywhere: 12-byte random IV, 16-byte tag, stored as iv || ciphertext || tag. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The HKDF info strings; a new version of any derivation gets a new string. */
const INFO = {
  kekPrf: 'masterpod/kek-prf/v1',
  kekBackup: 'masterpod/kek-backup/v1',
  backupP256: 'masterpod/backup-p256/v1',
  backupMldsa: 'masterpod/backup-mldsa/v1',
  roomKeyWrap: 'masterpod/room-key-wrap/v1',
  hybrid: 'keyholder/hybrid/v1',
  breakGlassP256: 'anos/break-glass-p256/v1',
  breakGlassMldsa: 'anos/break-glass-mldsa/v1',
} as const;

const P256_PUBLIC_BYTES = 33;
const X25519_PUBLIC_BYTES = 32;
const KEM_CIPHERTEXT_BYTES = 1568;
const WRAPPED_KEY_BYTES = IV_BYTES + 32 + TAG_BYTES;
const HPKE_KEY_BYTES = P256_PUBLIC_BYTES + KEM_CIPHERTEXT_BYTES + WRAPPED_KEY_BYTES;

/** A dispute case's secret (masterpod spec 13.6): the 96 bytes of a hybrid pair, and its wrap to a chat key, 1725 bytes. */
const CASE_SECRET_BYTES = 96;
const CASE_WRAP_BYTES = P256_PUBLIC_BYTES + KEM_CIPHERTEXT_BYTES + IV_BYTES + CASE_SECRET_BYTES + TAG_BYTES;

/** RFC 4648 base32, no padding: 32 bytes are 52 characters. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Everything the wallet computes lives here, so no page touches noble,
 * WebCrypto, canonicalize or shamir directly: the masterpod derivations
 * (keys, blobs, the backup code, the chat pair, rooms, messages, the
 * buckets), the keyholder hybrid encryption and the shares, the anos keys,
 * builders and signing, the wallet spec's section 7 additions (the
 * identity blob, the break-glass keys, the key blob, the account envelope)
 * and the recovery additions of masterpod 12.6 (the hybrid pair and its
 * blob, opening a hybrid ciphertext, combining shares, the sign-off), and
 * the attestation additions of masterpod 13.6 (a case secret wrapped to a
 * chat key, a content key). The public ledger id is beside this file, in
 * public-ledger-id.ts.
 */
@Injectable({ providedIn: 'root' })
export class CryptoService {
  private get subtle(): SubtleCrypto {
    return globalThis.crypto.subtle;
  }

  // --- bytes ---------------------------------------------------------------

  randomBytes(length: number): Bytes {
    return toBuffer(randomBytes(length));
  }

  randomHex(length: number): string {
    return bytesToHex(randomBytes(length));
  }

  toHex(bytes: Uint8Array): string {
    return bytesToHex(bytes);
  }

  fromHex(hex: string): Bytes {
    return toBuffer(hexToBytes(hex));
  }

  utf8(text: string): Bytes {
    return toBuffer(utf8ToBytes(text));
  }

  fromUtf8(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
  }

  toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  fromBase64(text: string): Bytes {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  /** SHA-256 of a UTF-8 string, as lowercase hex. */
  sha256Hex(text: string): string {
    return bytesToHex(sha256(utf8ToBytes(text)));
  }

  /** RFC 8785 canonical JSON (sorted keys, no whitespace) as UTF-8 bytes. */
  canonicalBytes(value: unknown): Bytes {
    const json = canonicalize(value);
    if (json === undefined) throw new Error('Value cannot be canonicalized');
    return this.utf8(json);
  }

  // --- signing (the pod envelope and the account envelope) ----------------

  /** Fresh ephemeral keys: a random P-256 pair (public key compressed, 33 bytes) and ML-DSA-87 from a random seed. */
  generateSessionKeys(): SessionKeys {
    return { ecdsa: this.generateP256Key(), mldsa: this.generateMlDsaKey() };
  }

  /**
   * Both signatures over the canonical bytes of `payload`: P-256 over the
   * SHA-256 of the message as r || s (64 bytes), ML-DSA-87 pure with an
   * empty context (4627 bytes), hex.
   */
  signPayload(keys: SessionKeys, payload: unknown): Signatures {
    const message = this.canonicalBytes(payload);
    return {
      ecdsa: bytesToHex(p256.sign(message, keys.ecdsa.secretKey)),
      mldsa: bytesToHex(ml_dsa87.sign(message, keys.mldsa.secretKey)),
    };
  }

  /**
   * The account envelope for the validators' reads (wallet spec 7): the pod
   * envelope with accountId as the signer field, signed by pair one, nonce
   * 16 random bytes.
   */
  signAccountEnvelope(pairOne: PairOne, accountId: string, path: string, body: object): Envelope {
    const payload = { accountId, path, timestamp: new Date().toISOString(), nonce: this.randomHex(16), body };
    return { payload, signatures: this.signPayload({ ecdsa: pairOne.key1, mldsa: pairOne.postQuantumKey1 }, payload) };
  }

  // --- HKDF and AES-GCM ----------------------------------------------------

  /** HKDF-SHA-256 with the given info string and salt; the masterpod and anos derivations use an empty salt, the keyholder hybrid one e.public || ct. */
  async hkdf(ikm: Uint8Array, info: string, length: number, salt: Uint8Array = new Uint8Array(0)): Promise<Bytes> {
    const key = await this.subtle.importKey('raw', toBuffer(ikm), 'HKDF', false, ['deriveBits']);
    const bits = await this.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: toBuffer(salt), info: this.utf8(info) },
      key,
      length * 8,
    );
    return new Uint8Array(bits);
  }

  /** AES-256-GCM with a fresh random IV: iv || ciphertext || tag. */
  async encrypt(key: Uint8Array, plaintext: Uint8Array): Promise<Bytes> {
    const aesKey = await this.subtle.importKey('raw', toBuffer(key), 'AES-GCM', false, ['encrypt']);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await this.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, toBuffer(plaintext));
    return toBuffer(concatBytes(iv, new Uint8Array(ciphertext)));
  }

  /** The reverse of encrypt(). Throws when the key is wrong or the blob was changed. */
  async decrypt(key: Uint8Array, blob: Uint8Array): Promise<Bytes> {
    if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('blob too short');
    const aesKey = await this.subtle.importKey('raw', toBuffer(key), 'AES-GCM', false, ['decrypt']);
    const plaintext = await this.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(blob.subarray(0, IV_BYTES)) },
      aesKey,
      toBuffer(blob.subarray(IV_BYTES)),
    );
    return new Uint8Array(plaintext);
  }

  // --- setup (masterpod spec section 7) --------------------------------------

  /** The pod's encryption key, 32 random bytes, born at setup. */
  newEncryptionKey(): Bytes {
    return this.randomBytes(32);
  }

  /** The backup code, 32 random bytes, born at setup and shown once. */
  newBackupCode(): Bytes {
    return this.randomBytes(32);
  }

  /** The backup code as 52 base32 characters in groups of 4, for the user to write down. */
  backupCodeText(code: Uint8Array): string {
    const base32 = toBase32(code);
    return base32.match(/.{1,4}/g)?.join(' ') ?? base32;
  }

  /** KEK_prf = HKDF(prf output, 'masterpod/kek-prf/v1', 32). */
  deriveKekPrf(prfOutput: Uint8Array): Promise<Bytes> {
    return this.hkdf(prfOutput, INFO.kekPrf, 32);
  }

  /** KEK_backup = HKDF(backup code, 'masterpod/kek-backup/v1', 32). */
  deriveKekBackup(code: Uint8Array): Promise<Bytes> {
    return this.hkdf(code, INFO.kekBackup, 32);
  }

  /**
   * The two public keys derived from the backup code: the P-256 scalar is
   * HKDF(code, 'masterpod/backup-p256/v1', 48) as a big-endian integer,
   * reduced modulo n - 1, plus 1; the ML-DSA-87 seed is HKDF(code,
   * 'masterpod/backup-mldsa/v1', 32).
   */
  async backupCodeKeys(code: Uint8Array): Promise<BackupCodeKeys> {
    const scalar = await this.derivedScalar(code, INFO.backupP256);
    const seed = await this.hkdf(code, INFO.backupMldsa, 32);
    return { p256Public: p256.getPublicKey(scalar), mldsaPublic: ml_dsa87.keygen(seed).publicKey };
  }

  /** A P-256 scalar from HKDF(ikm, info, 48) as an integer mod (n - 1), plus 1: the backup code's rule, the break-glass key's too. */
  private async derivedScalar(ikm: Uint8Array, info: string): Promise<Bytes> {
    const wide = await this.hkdf(ikm, info, 48);
    const n = p256.Point.Fn.ORDER;
    const scalar = (BigInt('0x' + bytesToHex(wide)) % (n - 1n)) + 1n;
    return this.fromHex(scalar.toString(16).padStart(64, '0'));
  }

  /** A fresh chat key pair: a random P-256 scalar and ML-KEM-1024 from a random 64-byte seed. */
  generateChatKeys(): ChatKeys {
    const { secretKey } = p256.keygen();
    return this.chatKeysFrom(secretKey, randomBytes(64));
  }

  /** The chat key pair from its 96 secret bytes: p256 scalar (32) || ml-kem seed (64). */
  chatKeysFromSecret(secret: Uint8Array): ChatKeys {
    if (secret.length !== 96) throw new Error(`chat secret must be 96 bytes, got ${secret.length}`);
    return this.chatKeysFrom(secret.subarray(0, 32), secret.subarray(32));
  }

  private chatKeysFrom(p256Secret: Uint8Array, kemSeed: Uint8Array): ChatKeys {
    const kem = ml_kem1024.keygen(kemSeed);
    return {
      p256Secret,
      kemSeed,
      p256Public: p256.getPublicKey(p256Secret),
      kemPublic: kem.publicKey,
      kemSecret: kem.secretKey,
    };
  }

  /** chatPrivateKeyBlob: the 96 secret bytes under the encryption key, 124 bytes. */
  wrapChatPrivateKey(chat: ChatKeys, encryptionKey: Uint8Array): Promise<Bytes> {
    return this.encrypt(encryptionKey, concatBytes(chat.p256Secret, chat.kemSeed));
  }

  /** The chat key pair back from its blob. */
  async unwrapChatPrivateKey(blob: Uint8Array, encryptionKey: Uint8Array): Promise<ChatKeys> {
    return this.chatKeysFromSecret(await this.decrypt(encryptionKey, blob));
  }

  // --- recovery (masterpod spec 12.6) ------------------------------------------

  /** A fresh recovery hybrid pair: a random X25519 secret and ML-KEM-1024 from a random 64-byte seed. */
  generateHybridKeys(): HybridKeys {
    const { secretKey } = x25519.keygen();
    return this.hybridKeysFrom(secretKey, randomBytes(64));
  }

  /** The hybrid pair from its 96 secret bytes: x25519 secret (32) || ml-kem seed (64). */
  hybridKeysFromSecret(secret: Uint8Array): HybridKeys {
    if (secret.length !== 96) throw new Error(`hybrid secret must be 96 bytes, got ${secret.length}`);
    return this.hybridKeysFrom(secret.subarray(0, 32), secret.subarray(32));
  }

  private hybridKeysFrom(x25519Secret: Uint8Array, kemSeed: Uint8Array): HybridKeys {
    const kem = ml_kem1024.keygen(kemSeed);
    return {
      x25519Secret,
      kemSeed,
      x25519Public: x25519.getPublicKey(x25519Secret),
      kemPublic: kem.publicKey,
      kemSecret: kem.secretKey,
    };
  }

  /** The public halves of a hybrid pair as the masterpod takes them: { x25519, mlkem }, hex. */
  hybridPublicKeyOf(keys: HybridKeys): HybridPublicKey {
    return { x25519: bytesToHex(keys.x25519Public), mlkem: bytesToHex(keys.kemPublic) };
  }

  /** hybridKeyBlob: the 96 secret bytes under KEK_prf of the recovery passkey, 124 bytes. */
  wrapHybridPrivateKey(keys: HybridKeys, kekPrf: Uint8Array): Promise<Bytes> {
    return this.encrypt(kekPrf, concatBytes(keys.x25519Secret, keys.kemSeed));
  }

  /** The hybrid pair back from its blob. */
  async unwrapHybridPrivateKey(blob: Uint8Array, kekPrf: Uint8Array): Promise<HybridKeys> {
    return this.hybridKeysFromSecret(await this.decrypt(kekPrf, blob));
  }

  /**
   * The backup code's two signing keys with their private halves, by section
   * 7's derivations (the public halves are what backupCodeKeys gives the
   * masterpod at setup): derived for one proof and dropped.
   */
  private async backupCodeSigningKeys(code: Uint8Array): Promise<SessionKeys> {
    const scalar = await this.derivedScalar(code, INFO.backupP256);
    const seed = await this.hkdf(code, INFO.backupMldsa, 32);
    return { ecdsa: this.p256KeyFromScalar(scalar), mldsa: this.generateMlDsaKey(seed) };
  }

  /**
   * The backup code proof (masterpod 12.6): both signatures over the
   * canonical bytes of `payload` by the keys the code derives, as the
   * session keys sign. The /recover-with-backup-code payload and the
   * rotation's message (by the old code) are signed this way.
   */
  async backupCodeProof(code: Uint8Array, payload: unknown): Promise<Signatures> {
    return this.signPayload(await this.backupCodeSigningKeys(code), payload);
  }

  /** breakGlassBlob (masterpod 12.6): an account's 32-byte break-glass seed under the encryption key, 60 bytes. */
  wrapBreakGlassSeed(seed: Uint8Array, encryptionKey: Uint8Array): Promise<Bytes> {
    return this.encrypt(encryptionKey, seed);
  }


  /** identityBlob (wallet spec 7): PLID (32) || lookupId (32) under the encryption key, 92 bytes. */
  wrapIdentity(publicLedgerIdHex: string, lookupIdHex: string, encryptionKey: Uint8Array): Promise<Bytes> {
    return this.encrypt(encryptionKey, concatBytes(hexToBytes(publicLedgerIdHex), hexToBytes(lookupIdHex)));
  }

  /** The two ids back from identityBlob, hex. */
  async unwrapIdentity(blob: Uint8Array, encryptionKey: Uint8Array): Promise<{ publicLedgerId: string; lookupId: string }> {
    const plain = await this.decrypt(encryptionKey, blob);
    if (plain.length !== 64) throw new Error(`identityBlob must open to 64 bytes, got ${plain.length}`);
    return { publicLedgerId: bytesToHex(plain.subarray(0, 32)), lookupId: bytesToHex(plain.subarray(32)) };
  }

  // --- rooms and messages -------------------------------------------------

  /** A room key, 32 random bytes, made by the room's creator. */
  newRoomKey(): Bytes {
    return this.randomBytes(32);
  }

  /**
   * hpkeKey for a member: an ephemeral P-256 pair e; ss1 = the x-coordinate
   * of ECDH(e, the member's chat P-256 key); (ct, ss2) = ML-KEM-1024
   * encapsulation to the member's chat ML-KEM key; KEK_room = HKDF(ss1 ||
   * ss2, 'masterpod/room-key-wrap/v1', 32); e.public (33) || ct (1568) ||
   * room key under KEK_room (60) = 1661 bytes.
   */
  async wrapRoomKey(roomKey: Uint8Array, memberP256PublicHex: string, memberKemPublicHex: string): Promise<Bytes> {
    const ephemeral = p256.keygen();
    const ss1 = p256.getSharedSecret(ephemeral.secretKey, hexToBytes(memberP256PublicHex), true).subarray(1);
    const { cipherText, sharedSecret: ss2 } = ml_kem1024.encapsulate(hexToBytes(memberKemPublicHex));
    const kek = await this.hkdf(concatBytes(ss1, ss2), INFO.roomKeyWrap, 32);
    const wrapped = await this.encrypt(kek, roomKey);
    return toBuffer(concatBytes(ephemeral.publicKey, cipherText, wrapped));
  }

  /** The room key out of an hpkeKey made for this pod, with its chat keys. */
  async unwrapRoomKey(hpkeKey: Uint8Array, chat: ChatKeys): Promise<Bytes> {
    if (hpkeKey.length !== HPKE_KEY_BYTES) throw new Error(`hpkeKey must be ${HPKE_KEY_BYTES} bytes, got ${hpkeKey.length}`);
    const ephemeralPublic = hpkeKey.subarray(0, P256_PUBLIC_BYTES);
    const cipherText = hpkeKey.subarray(P256_PUBLIC_BYTES, P256_PUBLIC_BYTES + KEM_CIPHERTEXT_BYTES);
    const wrapped = hpkeKey.subarray(P256_PUBLIC_BYTES + KEM_CIPHERTEXT_BYTES);
    const ss1 = p256.getSharedSecret(chat.p256Secret, ephemeralPublic, true).subarray(1);
    const ss2 = ml_kem1024.decapsulate(cipherText, chat.kemSecret);
    const kek = await this.hkdf(concatBytes(ss1, ss2), INFO.roomKeyWrap, 32);
    return this.decrypt(kek, wrapped);
  }

  /** A message: UTF-8 text under the room key, base64 on the wire. */
  async encryptText(roomKey: Uint8Array, text: string): Promise<string> {
    return this.toBase64(await this.encrypt(roomKey, this.utf8(text)));
  }

  /** The text of a message from the wire. */
  async decryptText(roomKey: Uint8Array, base64: string): Promise<string> {
    return this.fromUtf8(await this.decrypt(roomKey, this.fromBase64(base64)));
  }

  // --- security buckets ------------------------------------------------------

  /** A bucket key, 32 random bytes per add, deposited with the keyholders and not kept. */
  newBucketKey(): Bytes {
    return this.randomBytes(32);
  }

  /** Bytes (an image, a text) under a bucket key, base64 on the wire. */
  async encryptToBase64(key: Uint8Array, bytes: Uint8Array): Promise<string> {
    return this.toBase64(await this.encrypt(key, bytes));
  }

  // --- keyholders (keyholder spec sections 7.1 and 8) -----------------------

  /**
   * Encrypting to a keyholder's hybrid key (keyholder spec 7.1): a fresh
   * X25519 pair e; ss1 = X25519(e, R.x25519); (ct, ss2) = ML-KEM-1024
   * encapsulation to R.mlkem; key = HKDF-SHA-256(ss1 || ss2, salt = e.public
   * || ct, 'keyholder/hybrid/v1', 32); AES-256-GCM over `plaintext` with
   * `aad` as authenticated data. Wire: e.public (32) || ct (1568) || iv (12)
   * || c || tag (16), 1628 bytes plus the plaintext.
   */
  async encryptToHybrid(recipient: HybridPublicKey, plaintext: Uint8Array, aad: Uint8Array): Promise<Bytes> {
    const ephemeral = x25519.keygen();
    const ss1 = x25519.getSharedSecret(ephemeral.secretKey, hexToBytes(recipient.x25519));
    const { cipherText, sharedSecret: ss2 } = ml_kem1024.encapsulate(hexToBytes(recipient.mlkem));
    const key = await this.hkdf(concatBytes(ss1, ss2), INFO.hybrid, 32, concatBytes(ephemeral.publicKey, cipherText));
    const aesKey = await this.subtle.importKey('raw', toBuffer(key), 'AES-GCM', false, ['encrypt']);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = await this.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: toBuffer(aad) }, aesKey, toBuffer(plaintext));
    return toBuffer(concatBytes(ephemeral.publicKey, cipherText, iv, new Uint8Array(sealed)));
  }

  /**
   * Opening a hybrid ciphertext made for this pair (keyholder spec 7.1), the
   * mirror of encryptToHybrid: e.public (32) || ct (1568) || iv (12) || c ||
   * tag (16); ss1 = X25519(our secret, e.public); ss2 = ML-KEM-1024
   * decapsulation of ct; the same HKDF with salt e.public || ct, the same
   * aad. What a moderator's one-time response pair opens (the keyholders'
   * bucket key answers) and what the recovery hybrid pair opens (a share a
   * banker delivered, build 3). Throws when the key or the aad is wrong or
   * the bytes were changed.
   */
  async decryptFromHybrid(keys: HybridKeys, wire: Uint8Array, aad: Uint8Array): Promise<Bytes> {
    const head = X25519_PUBLIC_BYTES + KEM_CIPHERTEXT_BYTES;
    if (wire.length < head + IV_BYTES + TAG_BYTES) throw new Error(`hybrid ciphertext too short: ${wire.length} bytes`);
    const ephemeralPublic = wire.subarray(0, X25519_PUBLIC_BYTES);
    const cipherText = wire.subarray(X25519_PUBLIC_BYTES, head);
    const iv = wire.subarray(head, head + IV_BYTES);
    const sealed = wire.subarray(head + IV_BYTES);
    const ss1 = x25519.getSharedSecret(keys.x25519Secret, ephemeralPublic);
    const ss2 = ml_kem1024.decapsulate(cipherText, keys.kemSecret);
    const key = await this.hkdf(concatBytes(ss1, ss2), INFO.hybrid, 32, concatBytes(ephemeralPublic, cipherText));
    const aesKey = await this.subtle.importKey('raw', toBuffer(key), 'AES-GCM', false, ['decrypt']);
    const plaintext = await this.subtle.decrypt({ name: 'AES-GCM', iv: toBuffer(iv), additionalData: toBuffer(aad) }, aesKey, toBuffer(sealed));
    return new Uint8Array(plaintext);
  }

  /** The authenticated data of a share in transit: lookupId || shareType (UTF-8) || keyId, raw bytes. */
  shareAad(lookupIdHex: string, shareType: string, keyIdHex: string): Bytes {
    return toBuffer(concatBytes(hexToBytes(lookupIdHex), utf8ToBytes(shareType), hexToBytes(keyIdHex)));
  }

  /** `count` Shamir shares of `secret`, any `threshold` of which rebuild it: 33 bytes each for a 32-byte secret. */
  splitSecret(secret: Uint8Array, count: number, threshold: number): Promise<Uint8Array[]> {
    return split(toBuffer(secret), count, threshold);
  }

  /** The secret back from `threshold` or more of its shares (shamir-secret-sharing combine): the 32-byte key from 33-byte shares. */
  async combineShares(shares: Uint8Array[]): Promise<Bytes> {
    return toBuffer(await combine(shares.map((share) => toBuffer(share))));
  }

  /** A moderator's sign-off (masterpod spec 12.6): both signatures over the canonical message by pair one, as the account envelope is signed. */
  signSignOff(pairOne: PairOne, message: SignOffMessage): Signatures {
    return this.signPayload({ ecdsa: pairOne.key1, mldsa: pairOne.postQuantumKey1 }, message);
  }

  /** A key id: 32 random bytes per secret, the same for all five keyholders and for the masterpod, hex. */
  newKeyId(): string {
    return this.randomHex(32);
  }

  // --- anos keys (wallet spec 7) ----------------------------------------------

  /** Random ECDSA P-256 key; public key is the 33-byte compressed form. */
  generateP256Key(): SigningKey {
    const { secretKey, publicKey } = p256.keygen();
    return { algorithm: 'P-256', secretKey, publicKey };
  }

  /** A P-256 key from its scalar. */
  p256KeyFromScalar(scalar: Uint8Array): SigningKey {
    return { algorithm: 'P-256', secretKey: scalar, publicKey: p256.getPublicKey(scalar) };
  }

  /** ML-DSA-87 key from a 32-byte seed, random unless one is given. */
  generateMlDsaKey(seed: Uint8Array = randomBytes(32)): SigningKey {
    const { secretKey, publicKey } = ml_dsa87.keygen(seed);
    return { algorithm: 'ML-DSA-87', secretKey, publicKey };
  }

  /** Fresh secrets for pair one and pair two: two P-256 scalars and two ML-DSA-87 seeds, 128 bytes. */
  generateAccountSecrets(): AccountSecrets {
    return {
      key1Scalar: p256.keygen().secretKey,
      postQuantumKey1Seed: randomBytes(32),
      key2Scalar: p256.keygen().secretKey,
      postQuantumKey2Seed: randomBytes(32),
    };
  }

  /** Pair one and pair two from their secrets: P-256 public keys from the scalars, ML-DSA-87 keys from their seeds. */
  pairKeysFromSecrets(secrets: AccountSecrets): PairKeys {
    return {
      key1: this.p256KeyFromScalar(secrets.key1Scalar),
      postQuantumKey1: this.generateMlDsaKey(secrets.postQuantumKey1Seed),
      key2: this.p256KeyFromScalar(secrets.key2Scalar),
      postQuantumKey2: this.generateMlDsaKey(secrets.postQuantumKey2Seed),
    };
  }

  /** keyBlob: key1 scalar || postQuantumKey1 seed || key2 scalar || postQuantumKey2 seed under the encryption key, 156 bytes. */
  wrapKeyBlob(secrets: AccountSecrets, encryptionKey: Uint8Array): Promise<Bytes> {
    return this.encrypt(encryptionKey, concatBytes(secrets.key1Scalar, secrets.postQuantumKey1Seed, secrets.key2Scalar, secrets.postQuantumKey2Seed));
  }

  /** The secrets back from keyBlob. */
  async unwrapKeyBlob(blob: Uint8Array, encryptionKey: Uint8Array): Promise<AccountSecrets> {
    const plain = await this.decrypt(encryptionKey, blob);
    if (plain.length !== 128) throw new Error(`keyBlob must open to 128 bytes, got ${plain.length}`);
    return {
      key1Scalar: plain.subarray(0, 32),
      postQuantumKey1Seed: plain.subarray(32, 64),
      key2Scalar: plain.subarray(64, 96),
      postQuantumKey2Seed: plain.subarray(96),
    };
  }

  /** Pair one out of a keyBlob, for one signature; the caller drops it afterwards. */
  async pairOneFromKeyBlob(blob: Uint8Array, encryptionKey: Uint8Array): Promise<PairOne> {
    const secrets = await this.unwrapKeyBlob(blob, encryptionKey);
    return { key1: this.p256KeyFromScalar(secrets.key1Scalar), postQuantumKey1: this.generateMlDsaKey(secrets.postQuantumKey1Seed) };
  }

  /** The break-glass seed, 32 random bytes per anos account, split and deposited as breakglasskey, then wiped. */
  newBreakGlassSeed(): Bytes {
    return this.randomBytes(32);
  }

  /**
   * The two break-glass keys from the seed: breakGlassKey a P-256 scalar =
   * HKDF(seed, 'anos/break-glass-p256/v1', 48) as an integer mod (n - 1),
   * plus 1; breakGlassPostQuantumKey = ML-DSA-87 keygen(HKDF(seed,
   * 'anos/break-glass-mldsa/v1', 32)). HKDF-SHA-256, empty salt.
   */
  async breakGlassKeys(seed: Uint8Array): Promise<BreakGlassKeys> {
    const scalar = await this.derivedScalar(seed, INFO.breakGlassP256);
    const mldsaSeed = await this.hkdf(seed, INFO.breakGlassMldsa, 32);
    return { breakGlassKey: this.p256KeyFromScalar(scalar), breakGlassPostQuantumKey: this.generateMlDsaKey(mldsaSeed) };
  }

  // --- the anos builders ---------------------------------------------------

  /**
   * The creation payload, the test wallet's buildCreateAccountTransaction
   * with the wallet keys from the signing server: the eight public keys in
   * schema order, accountId the SHA-256 of key1 + postQuantumKey1 (the hex
   * strings joined), transactionId the SHA-256 of all eight joined, signed by
   * the six keys here over the RFC 8785 canonical bytes; /api/sign adds the
   * two wallet signatures.
   */
  buildCreateAccountTransaction(keys: BrowserAccountKeys, walletKeys: WalletPublicKeys, accountType: AccountType): CreateAccountTransaction {
    const publicKeys = Object.fromEntries(
      KEY_ROLES.map((role) => [role, role in keys ? bytesToHex(keys[role as BrowserKeyRole].publicKey) : walletKeys[role as keyof WalletPublicKeys]]),
    ) as Record<KeyRole, string>;
    const payload: CreateAccountPayload = {
      accountId: this.sha256Hex(publicKeys.key1 + publicKeys.postQuantumKey1),
      accountType,
      createdAt: new Date().toISOString(),
      transactionId: this.sha256Hex(KEY_ROLES.map((role) => publicKeys[role]).join('')),
      transactionType: 'accountCreation',
      publicKeys,
    };
    const message = this.canonicalBytes(payload);
    const signatures = Object.fromEntries(BROWSER_KEY_ROLES.map((role) => [role, bytesToHex(this.sign(keys[role], message))]));
    return { payload, signatures };
  }

  /**
   * A transfer of the given type out of `accountId`, chained on
   * `previousTransactionId` (the account's latest transaction, from
   * /get-account), dated `createdAt`: now for a plain, escrow or assisted
   * transfer, the lock plus the offset ahead for a guarded or vault one. The
   * transactionId is the SHA-256 of the canonical payload without it; the
   * payload with it is signed by pair one; /api/sign adds the wallet pair.
   */
  buildAnosTransferTransaction(
    pairOne: PairOne,
    accountId: string,
    previousTransactionId: string,
    accountIdTo: string,
    amount: bigint,
    transactionType: TransferType,
    createdAt: Date,
  ): AnosTransferTransaction {
    const payload = this.withTransactionId({
      accountId,
      previousTransactionId,
      transactionType,
      amount: amount.toString(),
      accountIdTo,
      createdAt: createdAt.toISOString(),
    });
    return { payload, signatures: this.signAsPairOne(pairOne, payload) };
  }

  /** A transfer to the fund staking `amount` (millionths) for `stakeFor`, dated now. */
  buildTransferToFund(pairOne: PairOne, accountId: string, previousTransactionId: string, amount: bigint, stakeFor: StakePurpose): TransferToFundTransaction {
    const payload = this.withTransactionId({
      accountId,
      previousTransactionId,
      transactionType: 'transferToFund' as const,
      amount: amount.toString(),
      accountIdTo: FUND_ACCOUNT_ID,
      createdAt: new Date().toISOString(),
      stakeFor,
    });
    return { payload, signatures: this.signAsPairOne(pairOne, payload) };
  }

  /** A fund proposal by the guardian whose pair one this is: the fund as accountId, dated now, the payouts as given. */
  buildFundProposal(pairOne: PairOne, guardianId: string, payouts: Payout[]): FundProposalTransaction {
    const payload = this.withTransactionId({
      accountId: FUND_ACCOUNT_ID,
      guardianId,
      transactionType: 'fundProposal' as const,
      createdAt: new Date().toISOString(),
      payouts,
    });
    return { payload, signatures: this.signAsPairOne(pairOne, payload) };
  }

  /** Any follow-up payload: signedAt (now) added, then signed by pair one. The validators compute the follow-up's own id. */
  buildFollowUp<T extends FollowUpPayload>(pairOne: PairOne, payload: T): FollowUp<T> {
    const signed = { ...payload, signedAt: new Date().toISOString() };
    return { payload: signed, signatures: this.signAsPairOne(pairOne, signed) };
  }

  /** P-256 signs sha256(message) in compact r||s form; ML-DSA signs the bytes directly. */
  sign(key: SigningKey, message: Uint8Array): Uint8Array {
    switch (key.algorithm) {
      case 'P-256':
        return p256.sign(message, key.secretKey);
      case 'ML-DSA-87':
        return ml_dsa87.sign(message, key.secretKey);
    }
  }

  /** The payload with its transactionId: the SHA-256 of the canonical JSON of the payload without it. */
  private withTransactionId<T extends object>(unsigned: T): T & { transactionId: string } {
    return { ...unsigned, transactionId: bytesToHex(sha256(this.canonicalBytes(unsigned))) };
  }

  /** Signatures over the payload's canonical bytes by pair one. */
  private signAsPairOne(pairOne: PairOne, payload: object): TransferSignatures {
    const message = this.canonicalBytes(payload);
    return {
      key1: bytesToHex(this.sign(pairOne.key1, message)),
      postQuantumKey1: bytesToHex(this.sign(pairOne.postQuantumKey1, message)),
    };
  }

  // --- attestation (masterpod spec 13.6) ---------------------------------------

  /**
   * A dispute case's secret wrapped to an attestor pod's chat public key:
   * the room key wrap of section 7 (wrapRoomKey: an ephemeral P-256 pair,
   * ML-KEM-1024 encapsulation, HKDF, AES-GCM) over the 96 secret bytes of
   * the case pair (x25519 secret (32) || ml-kem seed (64)): e.public (33) ||
   * ct (1568) || the secret under KEK_room (124) = 1725 bytes. The opener
   * wraps one for every attestor pod, itself included.
   */
  wrapCaseSecret(secret: Uint8Array, chatP256PublicHex: string, chatKemPublicHex: string): Promise<Bytes> {
    if (secret.length !== CASE_SECRET_BYTES) throw new Error(`case secret must be ${CASE_SECRET_BYTES} bytes, got ${secret.length}`);
    return this.wrapRoomKey(secret, chatP256PublicHex, chatKemPublicHex);
  }

  /**
   * The 96 secret bytes of a case pair out of a wrap made for this pod, with
   * its chat keys (the mirror of wrapCaseSecret, as unwrapRoomKey mirrors
   * wrapRoomKey); hybridKeysFromSecret makes the pair. Throws when the
   * bytes were not wrapped for these keys.
   */
  async unwrapCaseSecret(wrapped: Uint8Array, chat: ChatKeys): Promise<Bytes> {
    if (wrapped.length !== CASE_WRAP_BYTES) throw new Error(`wrapped case key must be ${CASE_WRAP_BYTES} bytes, got ${wrapped.length}`);
    const ephemeralPublic = wrapped.subarray(0, P256_PUBLIC_BYTES);
    const cipherText = wrapped.subarray(P256_PUBLIC_BYTES, P256_PUBLIC_BYTES + KEM_CIPHERTEXT_BYTES);
    const sealed = wrapped.subarray(P256_PUBLIC_BYTES + KEM_CIPHERTEXT_BYTES);
    const ss1 = p256.getSharedSecret(chat.p256Secret, ephemeralPublic, true).subarray(1);
    const ss2 = ml_kem1024.decapsulate(cipherText, chat.kemSecret);
    const kek = await this.hkdf(concatBytes(ss1, ss2), INFO.roomKeyWrap, 32);
    const secret = await this.decrypt(kek, sealed);
    if (secret.length !== CASE_SECRET_BYTES) throw new Error(`case secret must open to ${CASE_SECRET_BYTES} bytes, got ${secret.length}`);
    return secret;
  }

  /** A content key, 32 random bytes per evidence file; the file goes under it, the key under the pod's encryption key and to the case key. */
  newContentKey(): Bytes {
    return this.randomBytes(32);
  }
}

/** RFC 4648 base32 without padding. */
function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0x1fff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
