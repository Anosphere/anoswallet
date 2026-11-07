import { Injectable, inject } from '@angular/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { PRF_SALT_LABEL } from '../constants';
import { ConfigService } from './config.service';
import { LanguageService } from './language.service';

/** A Uint8Array over its own ArrayBuffer, which WebAuthn and WebCrypto require. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Copies any byte view into a fresh ArrayBuffer-backed array. */
export function toBuffer(source: Uint8Array | ArrayBuffer): Bytes {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  const out = new Uint8Array(source.byteLength);
  out.set(source);
  return out;
}

/**
 * The PRF input of the masterpod spec section 7: SHA-256(PRF_SALT_LABEL),
 * the 32-byte `first` value at create and at every get. Public; it only
 * labels the key.
 */
export const PRF_SALT: Bytes = toBuffer(sha256(utf8ToBytes(PRF_SALT_LABEL)));

const RP_NAME = 'anoPod';
const CEREMONY_TIMEOUT_MS = 120_000;

/** The registration JSON for /create-anopod, and the PRF output when the authenticator evaluated it at creation. */
export interface Registration {
  passkey: Record<string, unknown>;
  prfOutput: Bytes | null;
}

/** The assertion JSON for /unlock (prf removed) and the PRF output, a secret that stays in this tab. */
export interface Assertion {
  assertion: Record<string, unknown>;
  prfOutput: Bytes;
}

/**
 * The WebAuthn ceremonies (the keyholder test app's passkey.service.ts,
 * with the relying-party id from the configuration). Both ask for the PRF
 * extension with the fixed salt, require user verification, and hand back
 * the browser's toJSON() form with the PRF results removed: the PRF output
 * never leaves the tab. The relying-party id comes from GET /api/config,
 * the proxy's RP_ID, not from the page's host: a wallet that cannot load
 * its configuration makes no passkey rather than one bound to the wrong id.
 */
@Injectable({ providedIn: 'root' })
export class PasskeyService {
  private readonly config = inject(ConfigService);
  private readonly lang = inject(LanguageService);

  /**
   * Registers a discoverable passkey for a new pod: the challenge from
   * /challenge, the pod id as the user handle. Refuses when the
   * authenticator does not report prf.enabled, since the server will.
   */
  async register(challengeHex: string, anopodIdHex: string, username: string, displayName: string): Promise<Registration> {
    const { rpId } = await this.config.load();
    const credential = await navigator.credentials.create({
      publicKey: {
        rp: { name: RP_NAME, id: rpId },
        user: { id: toBuffer(hexToBytes(anopodIdHex)), name: username, displayName },
        challenge: toBuffer(hexToBytes(challengeHex)),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
        attestation: 'none',
        timeout: CEREMONY_TIMEOUT_MS,
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    });
    const pkc = asPublicKeyCredential(credential, this.lang.words().passkey.noCredential);
    const ext = pkc.getClientExtensionResults();
    if (ext.prf?.enabled !== true) {
      throw new Error(this.lang.words().passkey.noPrfSupport);
    }
    const json = toJson(pkc);
    const first = ext.prf.results?.first;
    const prfOutput = first ? toBuffer(first instanceof ArrayBuffer ? first : new Uint8Array(first.buffer, first.byteOffset, first.byteLength)) : null;
    const clientExtensionResults = { ...(json['clientExtensionResults'] as object), prf: { enabled: true } };
    return { passkey: { ...json, clientExtensionResults }, prfOutput };
  }

  /**
   * Authenticates with any passkey of this site and evaluates the PRF.
   * The assertion JSON goes to /unlock without its prf results.
   */
  async assert(challengeHex: string): Promise<Assertion> {
    const { rpId } = await this.config.load();
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: toBuffer(hexToBytes(challengeHex)),
        rpId,
        userVerification: 'required',
        timeout: CEREMONY_TIMEOUT_MS,
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    });
    const pkc = asPublicKeyCredential(credential, this.lang.words().passkey.noCredential);
    const first = pkc.getClientExtensionResults().prf?.results?.first;
    if (!first) {
      throw new Error(this.lang.words().passkey.noPrfOutput);
    }
    const json = toJson(pkc);
    const results = { ...(json['clientExtensionResults'] as Record<string, unknown>) };
    delete results['prf'];
    const bytes = first instanceof ArrayBuffer ? first : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
    return { assertion: { ...json, clientExtensionResults: results }, prfOutput: toBuffer(bytes) };
  }
}

/** The credential as a PublicKeyCredential; `noCredential` is the dictionary's sentence thrown when it is not one. */
function asPublicKeyCredential(credential: Credential | null, noCredential: string): PublicKeyCredential {
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error(noCredential);
  }
  return credential;
}

/**
 * The credential in the form PublicKeyCredential.toJSON() gives it:
 * base64url everywhere. Always built by hand, never with the browser's own
 * toJSON(): WebKit on iOS 18 traps inside PublicKeyCredential.toJSON() when
 * PRF outputs are present (its serialiser reads the largeBlob output, which
 * was never asked for), which kills the page process where no JavaScript
 * can catch it. Seen 2026-11-05 on an iPhone 11, iOS 18.7.8: the create
 * stepper restarted empty after the passkey was saved, and Unlock would
 * have died the same way.
 */
function toJson(pkc: PublicKeyCredential): Record<string, unknown> {
  const response: Record<string, unknown> = { clientDataJSON: toBase64Url(pkc.response.clientDataJSON) };
  if (pkc.response instanceof AuthenticatorAttestationResponse) {
    response['attestationObject'] = toBase64Url(pkc.response.attestationObject);
    response['transports'] = typeof pkc.response.getTransports === 'function' ? pkc.response.getTransports() : [];
  } else if (pkc.response instanceof AuthenticatorAssertionResponse) {
    response['authenticatorData'] = toBase64Url(pkc.response.authenticatorData);
    response['signature'] = toBase64Url(pkc.response.signature);
    response['userHandle'] = pkc.response.userHandle ? toBase64Url(pkc.response.userHandle) : null;
  }
  return {
    id: pkc.id,
    rawId: toBase64Url(pkc.rawId),
    type: pkc.type,
    authenticatorAttachment: pkc.authenticatorAttachment,
    response,
    clientExtensionResults: pkc.getClientExtensionResults(),
  };
}

function toBase64Url(buffer: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(buffer)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
