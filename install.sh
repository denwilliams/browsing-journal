#!/bin/sh
# Build and install the journal server and the launchd agent.
#
#   ./install.sh              build, install to ~/.local/bin, (re)start the agent
#   ./install.sh --no-agent   build and install the binaries only
#   ./install.sh uninstall    stop the agent, remove the binaries and plist (journal files are kept)
#
# The agent runs the installed copies, so this repo can live anywhere.
set -eu

ACTION=${1:-install}
LABEL=com.den.browsing-journal
ROOT=$(cd "$(dirname "$0")" && pwd)
BIN=${PREFIX:-$HOME/.local/bin}
AGENT=$HOME/Library/LaunchAgents/$LABEL.plist
DOMAIN=gui/$(id -u)

case $ACTION in
  install | --no-agent) ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$AGENT" "$BIN/journal-server" "$BIN/journal-summarize"
    echo "Removed the agent and binary. Journal files in ~/browsing-journal were left alone."
    exit 0
    ;;
  *)
    echo "usage: $0 [install|--no-agent|uninstall]" >&2
    exit 2
    ;;
esac

# Build into a temp dir and move into place. Overwriting a running binary in place can get the
# process killed on Apple silicon; a rename gives it a fresh inode and leaves the old one running.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$BIN"

echo "Building server..."
swiftc -O "$ROOT/server/main.swift" -o "$TMP/journal-server"
mv "$TMP/journal-server" "$BIN/journal-server"
rm -f "$BIN/journal-summarize" # separate helper from the old Go version of the server
echo "Installed $BIN/journal-server"

[ "$ACTION" = "--no-agent" ] && exit 0

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$ROOT/$LABEL.plist" "$AGENT"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns before the old job is gone, and bootstrapping too early fails with
# "Input/output error". Wait for it to disappear, then retry a few times to be safe.
i=0
while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ "$i" -lt 50 ]; do
  sleep 0.2
  i=$((i + 1))
done
n=0
until launchctl bootstrap "$DOMAIN" "$AGENT" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -ge 5 ]; then
    echo "launchctl bootstrap failed after $n attempts" >&2
    exit 1
  fi
  sleep 1
done
# launchd can leave RunAtLoad jobs unstarted in some sessions (see README), so start it explicitly.
launchctl kickstart -k "$DOMAIN/$LABEL"

sleep 2
if [ "$(curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:47821/health)" = 204 ]; then
  echo "Server is running."
else
  echo "Server did not answer on 127.0.0.1:47821. Check ~/Library/Logs/browsing-journal.log" >&2
  exit 1
fi
