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
# NixOS publishes its root-owned system profile here, including file symlinks.
# Trust this OS path just like /usr/bin; never bootstrap readlink from PATH.
[ -x "$canonical" ] || canonical=/run/current-system/sw/bin/readlink
[ -x "$canonical" ] || { printf '%s\n' 'Ponytail: system readlink required' >&2; exit 1; }
# cd -P resolves directory links; plain readlink also works on Darwin/BSD.
canonicalize() (
  value=$1 hops=0
  while [ "$hops" -lt 40 ]; do
    parent=$(CDPATH= cd -P -- "${value%/*}" 2>/dev/null && pwd -P) || exit 1
    value=$parent/${value##*/}
    if [ ! -L "$value" ]; then printf '%s\n' "$value"; exit 0; fi
    target=$("$canonical" "$value") || exit 1
    case "$target" in /*) value=$target;; *) value=$parent/$target;; esac
    hops=$((hops + 1))
  done
  exit 1
)
node=
clean_path=
remaining=${PATH:-}
while [ -n "$remaining" ]; do
  directory=${remaining%%:*}
  case "$remaining" in *:*) remaining=${remaining#*:};; *) remaining=;; esac
  case "$directory" in /*) ;; *) continue;; esac
  case "$directory/" in "$prefix"*) continue;; *) directory=$(canonicalize "$directory") || continue;; esac
  [ -d "$directory" ] || continue
  case "$directory/" in "$prefix"*) continue;; *) clean_path=${clean_path:+$clean_path:}$directory;; esac
  [ -z "$node" ] || continue
  candidate=$directory/node
  [ -x "$candidate" ] || continue
  actual=$(canonicalize "$candidate") || continue
  case "$actual" in "$boundary"|"$prefix"*) continue;; *) node=$actual;; esac
done
[ -n "$node" ] || { printf '%s\n' 'Ponytail: install Node outside the checkout on an absolute PATH' >&2; exit 1; }
# Prevent Node preload options from executing checkout code before the snapshot.
unset NODE_OPTIONS NODE_PATH
PATH=$clean_path
export PATH
exec "$node" "${0%/*}/.agents/hooks/ponytail-$action.js" "$host" "$root" "${3:-}"
