import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProxyMiddleware } from 'http-proxy-middleware';

/**
 * The wallet's proxy (wallet spec section 2): the one origin the browser
 * talks to. /api/config tells the browser how many validators and
 * keyholders there are and which edition this is (12.1); everything else
 * under /api is forwarded to a
 * backend with its prefix stripped, bodies streamed, headers as received,
 * the backend's status and body returned unchanged; the rest is the Angular
 * build. Nothing is logged but 502s.
 *
 * Every proxy is mounted at the root with a pathFilter, so it sees the full
 * path (an app.use('/prefix') mount would strip the prefix before the
 * rewrite ran).
 */

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
 * given, limits it to that method (the two signing server routes).
 */
function forward(config, target, who, prefix, replacement = '', method = null) {
  return createProxyMiddleware({
    target,
    changeOrigin: false,
    proxyTimeout: config.proxyTimeoutMs,
    timeout: config.proxyTimeoutMs,
    pathFilter: (path, req) => prefix.test(path) && (method === null || req.method === method),
    pathRewrite: (path) => path.replace(prefix, replacement) || '/',
    on: { error: unavailable(who) },
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

  // No express.json in front of the proxies: bodies stream through as they
  // are, so a 70 MB bucket request passes untouched.
  app.get('/api/config', (req, res) => {
    res.json({
      validators: config.validatorUrls.length,
      keyholders: config.keyholderUrls.length,
      shareThreshold: config.shareThreshold,
      defaultValidator: config.defaultValidator,
      edition: config.edition,
    });
  });
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(forward(config, config.masterpodUrl, 'masterpod', /^\/api\/masterpod(?=\/|$)/));
  config.validatorUrls.forEach((target, i) => {
    app.use(forward(config, target, `validator ${i + 1}`, new RegExp(`^/api/anos/${i + 1}(?=/|$)`)));
  });
  app.use(unknownNumber('anos', 'validator', config.validatorUrls.length));
  config.keyholderUrls.forEach((target, i) => {
    app.use(forward(config, target, `keyholder ${i + 1}`, new RegExp(`^/api/keyholder/${i + 1}(?=/|$)`)));
  });
  app.use(unknownNumber('keyholder', 'keyholder', config.keyholderUrls.length));
  app.use(forward(config, config.signingServerUrl, 'signing server', /^\/api\/sign\/public-keys$/, '/public-keys', 'GET'));
  app.use(forward(config, config.signingServerUrl, 'signing server', /^\/api\/sign$/, '/sign', 'POST'));

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
