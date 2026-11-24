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
 * Every answer of this program carries the page's three safety headers,
 * the Angular build's files and the answers under /api alike
 * (PAGE_HEADERS; 2026-11-19, wallet spec 2). The page also gets its
 * content security policy (PAGE_POLICY), which says where a wallet page
 * may take its scripts, style rules, fonts and pictures from; whether a
 * browser holds a page to it or only reports is said where createApp
 * sets it.
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
 *
 * One address outside /api is asked of a backend too (2026-11-23, wallet
 * spec 4.16): GET /stickers/<set>/<number>, the picture of a sticker of
 * the wallet's chat. It is asked of the masterpod and handed to the
 * browser as a picture that the browser keeps; the lines are where
 * createApp mounts it.
 */

/**
 * The page's safety headers, on every answer of this program (wallet spec
 * 2). The values are the monitor's (monitorsoftware/server/app.js): the
 * browser does not guess a file's type, no other site's page may show the
 * wallet inside itself, and the browser tells no other site which wallet
 * page a person came from. Strict-Transport-Security is not here: nginx
 * adds it, where TLS is (deploy/nginx/wallet.conf).
 */
const PAGE_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
});

/**
 * The page's content security policy (wallet spec 2): the monitor's, with
 * blob: added for pictures. Scripts run only from this program's own
 * files. 'unsafe-inline' for styles is what Angular Material needs. The
 * two Google hosts are the fonts. Pictures are the build's own files,
 * data: addresses (a selfie inside an answer and, since 2026-11-22, a
 * public room's picture) and blob: addresses (a picture opened in the
 * browser: images.ts, the camera, the recovery page). Every call goes to
 * /api on this address. script-src 'self' needs a build that writes no
 * script into the page itself: inlineCritical is false in angular.json.
 */
const PAGE_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

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

/**
 * The address of a sticker's picture at this program (2026-11-23, wallet
 * spec 4.16), with nothing before it and nothing after it: the set's
 * name, small letters, digits and hyphens, and the sticker's number, two
 * digits, as the masterpod has them (its spec, section 28).
 */
const STICKER_PATH = /^\/stickers\/[a-z0-9-]{1,32}\/[0-9]{2}$/;

/**
 * What a sticker's picture says to the browser about keeping it (wallet
 * spec 4.16): for a year, with no question in that time whether it has
 * changed. A picture never changes under its number; a sticker that is
 * drawn again gets a new number.
 */
const STICKER_KEEP = 'public, max-age=31536000, immutable';

/**
 * Called with the masterpod's answer to a sticker's picture, as
 * ownAnswerHeaders is under /api. Only one answer is handed on as a
 * picture: a 200 that the masterpod calls image/webp. It goes on as
 * image/webp with its length and STICKER_KEEP, and with no other header
 * of the masterpod's. Every other answer, a sticker that is not there
 * among them, goes on with its status and its body as JSON or plain
 * text, marked "no-store": the browser does not keep it and asks again
 * the next time the picture is to show.
 */
function ownPictureHeaders(proxyRes) {
  const picture = proxyRes.statusCode === 200 && /^image\/webp\s*(;|$)/i.test(proxyRes.headers['content-type'] ?? '');
  ownAnswerHeaders(proxyRes);
  if (picture) proxyRes.headers['content-type'] = 'image/webp';
  proxyRes.headers['cache-control'] = picture ? STICKER_KEEP : 'no-store';
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

  // The page's safety headers on every answer (PAGE_HEADERS), and with
  // them the page's content security policy (PAGE_POLICY), in force: the
  // browser blocks what the policy does not allow. Under /api the lines
  // below write API_HEADERS's own policy over it.
  app.use((req, res, next) => {
    res.set(PAGE_HEADERS);
    res.set('Content-Security-Policy', PAGE_POLICY);
    next();
  });

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

  // The stickers' pictures (2026-11-23, wallet spec 4.16), in front of the
  // build's files and outside /api, where every answer is JSON or plain
  // text that the browser may not keep. GET /stickers/<set>/<number> is
  // asked of the masterpod as /sticker-picture/<set>/<number>, a read that
  // needs no login: a sticker is the same for everybody. None of the
  // browser's headers goes with the ask. So the question whether a picture
  // has changed (If-None-Match) never reaches the masterpod, which then
  // always answers with the whole picture, and this program hands out no
  // ETag to ask with. Whatever is under /stickers and is not answered as a
  // picture is marked "no-store": an answer of the masterpod's that is no
  // picture (ownPictureHeaders), a masterpod that does not answer (502),
  // and an address of another form or a method other than GET (404).
  app.use('/stickers', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    for (const name of Object.keys(req.headers)) {
      if (name !== 'connection') delete req.headers[name];
    }
    next();
  });
  app.use(
    createProxyMiddleware({
      target: config.masterpodUrl,
      changeOrigin: true,
      proxyTimeout: config.proxyTimeoutMs,
      timeout: config.proxyTimeoutMs,
      pathFilter: (path, req) => req.method === 'GET' && STICKER_PATH.test(req.url),
      pathRewrite: (path) => path.replace(/^\/stickers\//, '/sticker-picture/'),
      on: { error: unavailable('masterpod'), proxyRes: ownPictureHeaders },
    }),
  );
  app.use('/stickers', (req, res) => {
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
