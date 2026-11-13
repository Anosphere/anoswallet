import { createApp } from './app.js';
import { config } from './config.js';

/**
 * Boots the proxy on PORT (4300 by default) and says where everything is.
 * In development ng serve on 4200 forwards /api here (proxy.conf.json); for
 * a production-like check `npm run build` then `npm run server` serves the
 * build from here too.
 */
const server = createApp(config).listen(config.port, () => {
  console.log(`wallet proxy listening on http://localhost:${config.port}`);
  console.log(`  masterpod       ${config.masterpodUrl}`);
  console.log(`  validators      ${config.validatorUrls.join(', ')} (default ${config.defaultValidator})`);
  console.log(`  keyholders      ${config.keyholderUrls.join(', ')} (threshold ${config.shareThreshold})`);
  console.log(`  signing servers ${config.signingServerUrls.join(', ')}`);
  console.log(`  build           ${config.distDir}`);
  console.log(`  edition         ${config.edition}`);
  console.log(`  rp id           ${config.rpId}`);
  console.log(`  locks           guarded ${config.guardedLockMinutes} min, vault ${config.vaultLockMinutes} min, offset ${config.lockOffsetMinutes} min`);
});

// Each of the thirteen proxies listens for the server closing; Node warns
// above ten listeners, so the limit is raised.
server.setMaxListeners(32);

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
