#!/bin/bash
cd "$(dirname "$0")"

# NOTE: Do NOT run this script with sudo / as root. The main process runs as
# your normal user. Only the networksetup proxy changes need admin rights,
# and those are executed individually via "sudo -n" by run.js.
# Before using proxy-on / proxy-off, run "sudo -v" once to cache credentials.
if [ "$EUID" -eq 0 ]; then
    echo "WARNING: Please do not run as root. Run ./run.sh as your normal user."
    echo "         Proxy changes use sudo internally when needed."
    echo
fi

# ---------- Locate node (Homebrew locations first, then PATH) ----------
NODE="node"
if [ -x /opt/homebrew/bin/node ]; then
    NODE="/opt/homebrew/bin/node"
elif [ -x /usr/local/bin/node ]; then
    NODE="/usr/local/bin/node"
fi

if ! command -v "$NODE" >/dev/null 2>&1; then
    echo "ERROR: node not found. Install it with: brew install node"
    read -n 1 -s -r -p "Press any key to close..."
    exit 1
fi

# ---------- Launch ----------
echo
echo "Starting Tor System-Wide Proxy..."
"$NODE" run.js "$@"
echo
read -n 1 -s -r -p "Press any key to close..."