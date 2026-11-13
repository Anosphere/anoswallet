import { Injectable, inject } from '@angular/core';
import { SIGNING_TIMEOUT_MS } from '../constants';
import { noAnswer } from './anos-api.service';
import { ConfigService } from './config.service';
import { SignedObject, WalletPublicKeys } from './crypto.service';
import { LanguageService } from './language.service';
import { ApiResponse, LogService, reasonOf } from './log.service';
import { SessionService } from './session.service';

/**
 * The signing servers through the proxy (wallet spec 3, 7 and 8.3;
 * 2026-11-13, the plan is forclaude/signing-server-plan-1.md): the public
 * keys of a wallet pair for a new account, and the signature, which adds
 * the two wallet signatures to a creation, a transfer, a proposal or a
 * follow-up the browser signed with its own keys.
 *
 * The session's signing server. The proxy lists the signing servers and
 * /api/config answers how many there are, `signingServers`; a proxy that
 * does not send the count has one. The wallet uses one signing server per
 * session, a session being one load of the wallet in a tab, so a reload
 * picks again. The first call picks it at random, a number from 1 to
 * `signingServers`, and every call goes to it. When it does not answer,
 * the session moves to the next one in the list, the first after the
 * last, and stays there, and the call is made again by itself: signing
 * the same thing twice does no harm, and the public keys are only read.
 * A call asks each signing server at most once; when none answers, the
 * last failure is returned. No answer is what it is for a validator
 * (noAnswer of anos-api.service): nothing came back (status 0: the
 * network failed, or the call ran into its time limit,
 * SIGNING_TIMEOUT_MS, 15 seconds), or 502, 503 or 504 (502: the wallet's
 * proxy could not reach the signing server; 503: the signing server got
 * no signature from its key store). Every other status is an answer, a
 * refusal included.
 *
 * The public keys are asked for every new account and never kept: a
 * signing server holds several wallet pairs and answers one of them,
 * picked at random, and the new account names that pair for life.
 *
 * The signer account's creation goes with every sign request but a
 * creation's own. Before it signs, the signing server checks without
 * asking anyone that the signer's account id is the hash of pair one's
 * public keys in that creation, that the wallet keys the creation names
 * are one of its own pairs, which is also the pair it signs with, and
 * that pair one signed the thing. The wallet sends the creation's payload
 * alone, without its eight signatures: the server does not read them.
 */
@Injectable({ providedIn: 'root' })
export class SigningService {
  private readonly log = inject(LogService);
  private readonly lang = inject(LanguageService);
  private readonly session = inject(SessionService);
  private readonly config = inject(ConfigService);

  /** The session's signing server: its number, from 1 to the `signingServers` of /api/config, by position in the proxy's list. Empty until the first call, which picks it at random (ask); a call that gets no answer moves it on. It lives as long as this load of the wallet in its tab. */
  private sessionServer: number | null = null;

  /** GET /api/sign/<n>/public-keys: the public keys of one of the signing server's wallet pairs, which the server picks at random, for a new account's creation. Nothing is kept: every call asks. */
  async publicKeys(): Promise<WalletPublicKeys> {
    const res = await this.ask((server) => this.log.get<WalletPublicKeys>(`/api/sign/${server}/public-keys`, false, SIGNING_TIMEOUT_MS));
    if (!res.ok) throw new Error(this.lang.words().signing.publicKeys(reasonOf(res)));
    return res.body;
  }

  /**
   * POST /api/sign/<n>: the transaction back with signatures.walletKey and
   * signatures.walletPostQuantumKey set. `signerAccountId` is the account
   * whose pair one signed the transaction, one of this pod's: the body is
   * then { transaction, creation: { payload } }, the payload being that
   * account's creation payload from the session's account list. An id that
   * is not in the list throws common.notMyAccount, and nothing is sent.
   * Without an id the body is { transaction }: only a creation is sent
   * that way, since it is its own creation.
   */
  async sign<T extends SignedObject>(transaction: T, signerAccountId?: string): Promise<T> {
    const body: { transaction: T; creation?: { payload: Record<string, unknown> } } = { transaction };
    if (signerAccountId !== undefined) {
      const account = this.session.accounts().find((a) => a.accountId === signerAccountId);
      if (!account) throw new Error(this.lang.words().common.notMyAccount);
      body.creation = { payload: account.creation.payload };
    }
    const res = await this.ask((server) => this.log.post<{ transaction: T }>(`/api/sign/${server}`, body, false, SIGNING_TIMEOUT_MS));
    if (!res.ok) throw new Error(this.lang.words().signing.sign(reasonOf(res)));
    return res.body.transaction;
  }

  /** One call, made on the session's signing server, which is picked now when none is set yet: one of the proxy's list, at random (Math.random is enough, nothing secret hangs on it). An answer is returned. With no answer (noAnswer) the session moves on to the next signing server in the list, the first after the last, and the call is made again on the one the session is on then, each signing server at most once per call; when none answers, the last failure is returned. The session moves only while it is still on the signing server that did not answer, so two calls that got no answer from it at the same moment move the session on by one place between them, not by one each. */
  private async ask<T>(call: (server: number) => Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
    const servers = (await this.config.load()).signingServers ?? 1;
    this.sessionServer ??= 1 + Math.floor(Math.random() * servers);
    const asked = new Set<number>();
    let server = this.sessionServer;
    let res: ApiResponse<T>;
    do {
      asked.add(server);
      res = await call(server);
      if (!noAnswer(res)) return res;
      if (this.sessionServer === server) this.sessionServer = (server % servers) + 1;
      server = this.sessionServer;
    } while (!asked.has(server));
    return res;
  }
}
