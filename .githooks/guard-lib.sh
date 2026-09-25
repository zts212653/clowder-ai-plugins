#!/bin/bash
# .githooks/guard-lib.sh — helpers shared by the clowder-ai-plugins git guards.
#
# Sourced by .githooks/pre-commit, .githooks/pre-push and
# scripts/install-git-guards.sh; it only defines names. Written for bash 3.2
# (the macOS /bin/bash) as well as current bash.

# The public upstream repository. Contributor clones mirror its main.
GUARD_UPSTREAM_IDENTITY="github.com/zts212653/clowder-ai-plugins"

_guard_host_re='^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'
_guard_name_re='^[A-Za-z0-9._-]+$'

# guard_repo_identity URL
#   Prints the lowercase host/owner/repo that URL names, and fails for anything
#   that does not name exactly one repository on a host: local paths, file://
#   and other schemes, missing or extra path segments, malformed names.
#   Accepts http(s)://, ssh://, git:// and the scp-like [user@]host:owner/repo,
#   with optional user info, port, ".git" suffix and trailing slash.
guard_repo_identity() {
  local url="$1" rest hostpart host path owner repo before
  [ -n "$url" ] || return 1
  case "$url" in
    *://*)
      case "$url" in
        http://*|https://*|ssh://*|git://*|git+ssh://*|ssh+git://*) ;;
        *) return 1 ;;
      esac
      rest="${url#*://}"
      case "$rest" in */*) ;; *) return 1 ;; esac
      hostpart="${rest%%/*}"
      path="${rest#*/}"
      hostpart="${hostpart##*@}"
      host="${hostpart%%:*}"
      ;;
    *)
      # scp-like syntax needs a colon before any slash; everything else is a
      # local path.
      before="${url%%:*}"
      [ "$before" != "$url" ] || return 1
      case "$before" in ''|*/*) return 1 ;; esac
      host="${before##*@}"
      path="${url#*:}"
      ;;
  esac
  path="${path%/}"
  path="${path%.git}"
  case "$path" in
    ''|/*|*/*/*) return 1 ;;
    */*) ;;
    *) return 1 ;;
  esac
  owner="${path%%/*}"
  repo="${path#*/}"
  [[ "$host" =~ $_guard_host_re ]] || return 1
  [[ "$owner" =~ $_guard_name_re ]] || return 1
  [[ "$repo" =~ $_guard_name_re ]] || return 1
  case "$owner" in .|..) return 1 ;; esac
  case "$repo" in .|..) return 1 ;; esac
  printf '%s/%s/%s\n' "$host" "$owner" "$repo" | tr '[:upper:]' '[:lower:]'
}

# guard_normalize_identity VALUE
#   Like guard_repo_identity, but also accepts the bare host/owner/repo form
#   that pnpm guards:install stores in git config.
guard_normalize_identity() {
  case "$1" in
    *://*|*:*) guard_repo_identity "$1" ;;
    *) guard_repo_identity "https://$1" ;;
  esac
}
