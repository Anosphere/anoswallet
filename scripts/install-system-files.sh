#!/bin/sh
# Puts the wallet's deploy/ files in place on a wallet server and starts or
# reloads what reads them: the TLS folder, the nginx site, the closed page,
# the three units.
# Run as root from the repo root:
#
#   sh scripts/install-system-files.sh
#
# Every step is safe to repeat. The site is installed only once the
# certificate exists at /etc/wallet/tls, so the script runs twice at setup,
# before and after the certificate (the deploy plan, sections 6 and 7), and
# again after any pull that touched deploy/. It restarts the three wallet
# units at the end.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sh scripts/install-system-files.sh" >&2
  exit 1
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$REPO/deploy"
if [ ! -f "$DEPLOY/wallet.service" ] || [ ! -f "$DEPLOY/nginx/wallet.conf" ]; then
  echo "deploy/ not found at $DEPLOY; run this script from the web_app checkout" >&2
  exit 1
fi

TLS=/etc/wallet/tls
ACCESS_LOG=/var/log/nginx/wallet-access.log

# 1. The TLS folder. The key file is created empty and owner-only before any
#    certificate exists, so the key lands in a file that is already 0600.
mkdir -p "$TLS"
chmod 755 "$TLS"
if [ ! -e "$TLS/key.pem" ]; then
  touch "$TLS/key.pem"
  chmod 600 "$TLS/key.pem"
fi

# 2. nginx: Debian's default site goes; the wallet site once both certificate
#    files are non-empty. The access log the site declares is created now if
#    it is missing.
rm -f /etc/nginx/sites-enabled/default
site=installed
if [ -s "$TLS/fullchain.pem" ] && [ -s "$TLS/key.pem" ]; then
  install -m 0644 "$DEPLOY/nginx/wallet.conf" /etc/nginx/sites-available/wallet
  ln -sf /etc/nginx/sites-available/wallet /etc/nginx/sites-enabled/wallet
else
  site=skipped
  echo "TLS site skipped: no certificate at $TLS yet; put it there, then run this script again"
fi
if [ ! -e "$ACCESS_LOG" ]; then
  touch "$ACCESS_LOG"
  chown root:adm "$ACCESS_LOG"
  chmod 640 "$ACCESS_LOG"
fi
# 2b. The closed page the site shows while /etc/wallet/closed exists or the
#     wallet does not answer; nginx reads it from /var/www/wallet.
install -D -m 0644 "$DEPLOY/nginx/closed.html" /var/www/wallet/closed.html

nginx -t
systemctl enable --now nginx
systemctl reload nginx

# 3. The three units.
install -m 0644 "$DEPLOY/wallet.service" "$DEPLOY/wallet-attestor.service" "$DEPLOY/wallet-moderator.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable wallet wallet-attestor wallet-moderator
systemctl restart wallet wallet-attestor wallet-moderator

# 4. What happened.
echo "Installed: $TLS, nginx site wallet ($site), the closed page at /var/www/wallet/closed.html, units wallet.service, wallet-attestor.service, wallet-moderator.service."
echo "The three units were restarted: journalctl -fu wallet"
if [ "$site" = skipped ]; then
  echo "Next: the certificate into $TLS (the deploy plan, section 7), then this script again."
fi
