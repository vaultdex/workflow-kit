#!/bin/sh
# Installed immutable bootstrap: no checkout code or PATH executable runs first.
set -eu
# Git Bash shares Windows' case-insensitive filesystem and junction semantics.
case "${OSTYPE:-}" in
  msys*|cygwin*) exec "${SYSTEMROOT:-${SystemRoot:-C:/Windows}}/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -NonInteractive -File "${0%/*}/launch.ps1" "$@";;
  *) canonical=/usr/bin/readlink;;
esac
action=$1 host=$2
case "$action" in activate|subagent|mode-tracker) ;; *) exit 1;; esac
directory=$(pwd -P)
root= boundary=
while :; do
  if [ -e "$directory/.git" ]; then
    [ -n "$root" ] || root=$directory
    boundary=$directory
  fi
  [ "$directory" != / ] || break
  directory=${directory%/*}; directory=${directory:-/}
done
[ -n "$root" ] || { printf '%s\n' 'Ponytail: no checkout root found' >&2; exit 1; }
prefix=${boundary%/}/
# Use the OS utility by absolute path, never a checkout-supplied readlink.
[ -x "$canonical" ] || canonical=/bin/readlink
[ -x "$canonical" ] || { printf '%s\n' 'Ponytail: system readlink required' >&2; exit 1; }
node=
remaining=${PATH:-}
while [ -n "$remaining" ]; do
  directory=${remaining%%:*}
  case "$remaining" in *:*) remaining=${remaining#*:};; *) remaining=;; esac
  case "$directory" in /*) ;; *) continue;; esac
  case "$directory/" in "$prefix"*) continue;; *) candidate=$directory/node;; esac
  [ -x "$candidate" ] || continue
  actual=$("$canonical" -f -- "$candidate") || continue
  case "$actual" in "$boundary"|"$prefix"*) continue;; *) node=$actual; break;; esac
done
[ -n "$node" ] || { printf '%s\n' 'Ponytail: install Node outside the checkout on an absolute PATH' >&2; exit 1; }
# Prevent Node preload options from executing checkout code before the snapshot.
unset NODE_OPTIONS NODE_PATH
exec "$node" "${0%/*}/.agents/hooks/ponytail-$action.js" "$host" "$root" "${3:-}"
