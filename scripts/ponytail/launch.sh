#!/bin/sh
# Installed immutable bootstrap: no checkout code or PATH executable runs first.
set -eu
action=$1 host=$2
case "$action" in activate|subagent|mode-tracker) ;; *) exit 1;; esac
root=$(pwd -P)
while [ ! -e "$root/.git" ]; do
  [ "$root" != / ] || { printf '%s\n' 'Ponytail: no checkout root found' >&2; exit 1; }
  root=${root%/*}; root=${root:-/}
done
# Use the OS utility by absolute path, never a checkout-supplied readlink.
canonical=/usr/bin/readlink
[ -x "$canonical" ] || canonical=/bin/readlink
[ -x "$canonical" ] || { printf '%s\n' 'Ponytail: system readlink required' >&2; exit 1; }
node=
remaining=${PATH:-}
while [ -n "$remaining" ]; do
  directory=${remaining%%:*}
  case "$remaining" in *:*) remaining=${remaining#*:};; *) remaining=;; esac
  case "$directory" in /*) ;; *) continue;; esac
  case "$directory/" in "$root/"*) continue;; esac
  candidate=$directory/node
  [ -x "$candidate" ] || continue
  actual=$("$canonical" -f -- "$candidate") || continue
  case "$actual" in "$root"|"$root/"*) continue;; esac
  node=$actual
  break
done
[ -n "$node" ] || { printf '%s\n' 'Ponytail: install Node outside the checkout on an absolute PATH' >&2; exit 1; }
# Prevent Node preload options from executing checkout code before the snapshot.
unset NODE_OPTIONS NODE_PATH
exec "$node" "${0%/*}/.agents/hooks/ponytail-$action.js" "$host" "$root" "${3:-}"
