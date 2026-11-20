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
  /** The new credential's id. */
  rawId: Bytes;
  /** The new credential's transports, as the browser names them. */
  transports: string[];
}

/** The assertion JSON for /unlock (prf removed) and the PRF output, a secret that stays in this tab. */
export interface Assertion {
  assertion: Record<string, unknown>;
  prfOutput: Bytes;
  /** The id of the credential that signed. */
  rawId: Bytes;
}

/**
 * The WebAuthn ceremonies (the keyholder test app's passkey.service.ts,
 * with the relying-party id from the configuration). Both ask for the PRF
 * extension with the fixed salt, require user verification, and hand back
 * the browser's toJSON() form with the PRF results removed: the PRF output
 * never leaves the tab. The relying-party id comes from GET /api/config,
 * the proxy's RP_ID, not from the page's host: a wallet that cannot load
 * its configuration makes no passkey rather than one bound to the wrong id.
 * For an add (2026-11-18, masterpod spec 19) the registration takes an
 * exclude list, the credential ids the anoPod already has, so a place that
 * holds one of them refuses instead of replacing it (the passkey of a
 * recovery case is registered with that list too, since 2026-11-18,
 * masterpod spec 20); and the assertion can be asked of one passkey alone,
 * the new one, for its PRF output. Since 2026-11-19 the passkey check
 * (passkey-check.ts, wallet spec 8.9) asks the assertion of one passkey
 * alone too: the one that opened the session, by its credential id, with
 * an empty transports list. Since 2026-11-20
 * (forclaude/second-key-and-signing-passkey-plan-1.md) the assertion of
 * that ask goes to a server as well, for every button but two:
 * askSigningPasskey hands it to the signing server with the request, and
 * the masterpod checks it.
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
  async register(challengeHex: string, anopodIdHex: string, username: string, displayName: string, exclude: Uint8Array[] = []): Promise<Registration> {
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
        excludeCredentials: exclude.map((id) => ({ type: 'public-key' as const, id: toBuffer(id) })),
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
    const transports = (json['response'] as { transports?: string[] }).transports ?? [];
    return { passkey: { ...json, clientExtensionResults }, prfOutput, rawId: toBuffer(pkc.rawId), transports };
  }

  /**
   * Authenticates with a passkey of this site and evaluates the PRF: any
   * passkey the device offers, or, with `only`, that one passkey alone
   * (the third tap of an add and, since 2026-11-19, the passkey check,
   * passkey-check.ts). The assertion JSON is handed back without its prf
   * results, so a caller can send it to the masterpod, as the unlock flow
   * sends it to /unlock, or, since 2026-11-20, to a signing server, which
   * has the masterpod check it (askSigningPasskey in passkey-check.ts). A
   * caller that needs only the PRF output or the
   * credential id sends it nowhere; the wallet-only passkey check
   * (checkSessionPasskey) is one of those.
   */
  async assert(challengeHex: string, only?: { id: Uint8Array; transports: string[] }): Promise<Assertion> {
    const { rpId } = await this.config.load();
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: toBuffer(hexToBytes(challengeHex)),
        rpId,
        ...(only ? { allowCredentials: [{ type: 'public-key' as const, id: toBuffer(only.id), transports: only.transports as AuthenticatorTransport[] }] } : {}),
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
    return { assertion: { ...json, clientExtensionResults: results }, prfOutput: toBuffer(bytes), rawId: toBuffer(pkc.rawId) };
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
