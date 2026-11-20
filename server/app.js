import express from 'express';
import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import { createProxyMiddleware } from 'http-proxy-middleware';

/**
 * The wallet's proxy (wallet spec section 2): the one origin the browser
 * talks to. /api/config tells the browser how many validators, keyholders
 * and signing servers there are, which edition this is (12.1), the
 * relying-party id, the three lock numbers and the deposit floor (wallet
 * spec 2); everything else under
 * /api is forwarded to a backend with its prefix stripped, bodies
 * streamed, the backend's status and body returned unchanged; the rest is
 * the Angular build. Nothing is logged but 502s.
 *
 * The headers do not go through as received (2026-11-19, wallet spec 2).
 * Out to a backend go three of the browser's headers, the body's type, its
 * length and the Origin, and no other (KEPT_REQUEST_HEADERS). Back to the
 * browser come the backend's status, its body and one header, the length
 * (KEPT_ANSWER_HEADERS): the content type is written here, JSON or plain
 * text (ownAnswerHeaders), and every answer under /api carries this
 * program's own three headers (API_HEADERS). Connection is the proxy
 * library's own on every call: "close", or "keep-alive" on a call to a
 * validator (below).
 *
 * Every proxy is mounted at the root with a pathFilter, so it sees the full
 * path (an app.use('/prefix') mount would strip the prefix before the
 * rewrite ran).
 *
 * The connections to the validators stay open (2026-11-11, wallet spec 2).
 * A call to a validator goes to its doorman on a connection that is open
 * and waiting when there is one, so it does not open a connection and set
 * up the encryption again. The proxy closes a connection that sat unused
 * for config.validatorIdleMs, 10 seconds, before the doorman closes it
 * after its own 15, and keeps at most config.validatorIdleConnections, 32,
 * unused ones per validator. For this the Connection header, on a call to
 * a validator, is set to keep-alive.
 * nginx in front of this proxy sends "Connection: close" with every call,
 * and passed on it would tell the doorman to close after its answer. The
 * masterpod, the keyholders and the signing servers get a new connection
 * for every call.
 */

/**
 * The headers of every answer under /api, this program's own and a
 * backend's (wallet spec 2). An answer under /api is data for the wallet's
 * own code and never a page: the browser may not guess its type, may not
 * keep it, and, should a person open such an address, runs nothing in it
 * and gives it none of the wallet's rights (sandbox).
 */
const API_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
});

/**
 * The request headers that are left on a call before it is forwarded
 * (wallet spec 2). A backend gets three of the browser's headers: the
 * body's type, its length, and the Origin. Every other one stops here,
 * the cookies, the address of the page the person is on (Referer) and
 * the name of their browser among them. Connection stays for the proxy
 * library, which never passes it on as it came: it writes "close", or
 * "keep-alive" on a call to a validator (the comment of forward).
 */
const KEPT_REQUEST_HEADERS = new Set(['content-type', 'content-length', 'origin', 'connection']);

/** The one header of a backend's answer that goes back to the browser as it came. */
const KEPT_ANSWER_HEADERS = new Set(['content-length']);

/**
 * Called with a backend's answer before the proxy library copies its
 * headers to the browser: takes every header off it but the length, and
 * writes the content type itself, JSON when the backend said JSON and
 * plain text for anything else. So a backend cannot set a cookie, send
 * the browser to another address, or have its answer drawn as a page
 * under the wallet's address. The status and the body are not touched.
 */
function ownAnswerHeaders(proxyRes) {
  const json = /^application\/json\s*(;|$)/i.test(proxyRes.headers['content-type'] ?? '');
  for (const name of Object.keys(proxyRes.headers)) {
    if (!KEPT_ANSWER_HEADERS.has(name)) delete proxyRes.headers[name];
  }
  proxyRes.headers['content-type'] = json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
}

/** 502 { error: "<who> unavailable" } when a backend does not answer. */
function unavailable(who) {
  return (err, req, res) => {
    console.log(`502 ${who} unavailable: ${req.method} ${req.originalUrl}: ${err.message}`);
    if (!res.headersSent) res.status(502).json({ error: `${who} unavailable` });
    else res.end();
  };
}

/**
 * A proxy to `target` for the paths `prefix` matches (a RegExp anchored at
 * the start), the matched prefix cut off and `replacement` put in its place
 * ('' by default, so /api/masterpod/unlock becomes /unlock); `method`, when
 * given, limits it to that method (the two signing server routes). With
 * changeOrigin the Host header, and with it the TLS server name, become the
 * target's, so the masterpod's certificate for api.anocloud.com and the
 * doormen's certificates for their addresses verify; the browser's Origin
 * header is forwarded as received. Of the browser's other headers only the
 * body's type and its length go with it (KEPT_REQUEST_HEADERS).
 *
 * `agent`, when given (the validators), is the agent the calls go out
 * through, one of the two createApp makes. It keeps a connection open after
 * a call, for the next call to the same address; it closes a connection
 * that sat unused for config.validatorIdleMs, and gives a new one that long
 * to open; it keeps at most config.validatorIdleConnections unused ones per
 * address. With it the outgoing Connection header is set to keep-alive.
 * http-proxy copies the incoming headers onto the outgoing call, and nginx
 * in front of this proxy sends "Connection: close" with every call, so the
 * agent alone would keep nothing open: the far end would still be told to
 * close after its answer. Without an agent (the masterpod, the keyholders,
 * the signing servers) http-proxy opens a new connection for every call and
 * sends "Connection: close".
 */
function forward(config, target, who, prefix, replacement = '', method = null, agent = null) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    proxyTimeout: config.proxyTimeoutMs,
    timeout: config.proxyTimeoutMs,
    pathFilter: (path, req) => prefix.test(path) && (method === null || req.method === method),
    pathRewrite: (path) => path.replace(prefix, replacement) || '/',
    on: { error: unavailable(who), proxyRes: ownAnswerHeaders },
    ...(agent === null ? {} : { agent, headers: { connection: 'keep-alive' } }),
  });
}

/** 404 for a numbered backend the list does not have: /api/anos/9/... */
function unknownNumber(kind, who, count) {
  return (req, res, next) => {
    const match = new RegExp(`^/api/${kind}/([0-9]+)(?:/|$)`).exec(req.path);
    if (match && !(Number(match[1]) >= 1 && Number(match[1]) <= count)) {
      res.status(404).json({ error: `unknown ${who}` });
      return;
    }
    next();
  };
}

export function createApp(config) {
  const app = express();
  app.disable('x-powered-by');

  // The headers of every answer under /api (API_HEADERS).
  app.use('/api', (req, res, next) => {
    res.set(API_HEADERS);
    next();
  });

  // No express.json in front of the proxies: bodies stream through as they
  // are, so a 70 MB bucket request passes untouched.
  app.get('/api/config', (req, res) => {
    res.json({
      validators: config.validatorUrls.length,
      keyholders: config.keyholderUrls.length,
      signingServers: config.signingServerUrls.length,
      shareThreshold: config.shareThreshold,
      depositFloorPercent: config.depositFloorPercent,
      defaultValidator: config.defaultValidator,
      edition: config.edition,
      rpId: config.rpId,
      guardedLockMinutes: config.guardedLockMinutes,
      vaultLockMinutes: config.vaultLockMinutes,
      lockOffsetMinutes: config.lockOffsetMinutes,
    });
  });
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // What is forwarded takes only the kept request headers with it. The two
  // routes above are answered before this and read no header.
  app.use('/api', (req, res, next) => {
    for (const name of Object.keys(req.headers)) {
      if (!KEPT_REQUEST_HEADERS.has(name)) delete req.headers[name];
    }
    next();
  });

  // The validators' two agents (the comment of forward), one for http
  // addresses and one for https addresses, made once and shared by every
  // call of this process.
  const kept = { keepAlive: true, timeout: config.validatorIdleMs, maxFreeSockets: config.validatorIdleConnections };
  const httpAgent = new http.Agent(kept);
  const httpsAgent = new https.Agent(kept);

  app.use(forward(config, config.masterpodUrl, 'masterpod', /^\/api\/masterpod(?=\/|$)/));
  config.validatorUrls.forEach((target, i) => {
    const agent = target.startsWith('https:') ? httpsAgent : httpAgent;
    app.use(forward(config, target, `validator ${i + 1}`, new RegExp(`^/api/anos/${i + 1}(?=/|$)`), '', null, agent));
  });
  app.use(unknownNumber('anos', 'validator', config.validatorUrls.length));
  config.keyholderUrls.forEach((target, i) => {
    app.use(forward(config, target, `keyholder ${i + 1}`, new RegExp(`^/api/keyholder/${i + 1}(?=/|$)`)));
  });
  app.use(unknownNumber('keyholder', 'keyholder', config.keyholderUrls.length));
  config.signingServerUrls.forEach((target, i) => {
    app.use(forward(config, target, `signing server ${i + 1}`, new RegExp(`^/api/sign/${i + 1}/public-keys$`), '/public-keys', 'GET'));
    app.use(forward(config, target, `signing server ${i + 1}`, new RegExp(`^/api/sign/${i + 1}$`), '/sign', 'POST'));
  });
  app.use(unknownNumber('sign', 'signing server', config.signingServerUrls.length));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not Found', path: req.originalUrl });
  });

  // The Angular build: its files, and index.html for any path that is not a
  // file, so the router's deep links load.
  const dist = resolve(config.distDir);
  const index = resolve(dist, 'index.html');
  app.use(express.static(dist, { index: 'index.html' }));
  app.use((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(404).json({ error: 'Not Found', path: req.originalUrl });
      return;
    }
    if (!existsSync(index)) {
      res.status(404).type('text/plain').send(`no build at ${dist}: run npm run build`);
      return;
    }
    res.sendFile(index);
  });

  return app;
}
