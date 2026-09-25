#!/bin/bash
# Install the clowder-ai-plugins git guards (pre-commit + pre-push) for this
# clone and every one of its worktrees.
#
#   pnpm guards:install <push destination> [--force]
#
# <push destination> is the one repository this clone may push to — normally
# your fork — given as a URL (e.g. "$(git remote get-url fork)") or as
# host/owner/repo. It is stored per clone in git config clowder.guard.pushRepo.
#
# The hooks are copied into the shared git directory and core.hooksPath points
# there, so they run in every worktree, including worktrees whose branch
# predates the guards. An existing core.hooksPath that points elsewhere is only
# replaced with --force. Re-run after pulling changes to .githooks/.
# Remove with: git config --unset core.hooksPath
set -euo pipefail

usage() {
  echo "usage: pnpm guards:install <push destination: fork URL or host/owner/repo> [--force]" >&2
  exit 2
}

FORCE=0
DESTINATION=""
# ${1+"$@"}: bash 3.2 treats an empty "$@" as unbound under set -u.
for arg in ${1+"$@"}; do
  case "$arg" in
    --force) FORCE=1 ;;
    -*) usage ;;
    *)
      [ -z "$DESTINATION" ] || usage
      DESTINATION="$arg"
      ;;
  esac
done
[ -n "$DESTINATION" ] || usage

REPO_ROOT=$(git rev-parse --show-toplevel)
SOURCE_DIR="$REPO_ROOT/.githooks"
# shellcheck source=../.githooks/guard-lib.sh
. "$SOURCE_DIR/guard-lib.sh"

if ! IDENTITY=$(guard_normalize_identity "$DESTINATION"); then
  echo "guards:install: cannot read a host/owner/repo repository from '${DESTINATION}'." >&2
  usage
fi

COMMON_DIR=$(cd "$REPO_ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
HOOKS_DIR="$COMMON_DIR/clowder-guard-hooks"

CURRENT=$(git config --get core.hooksPath || true)
if [ -n "$CURRENT" ] && [ "$CURRENT" != "$HOOKS_DIR" ] && [ "$CURRENT" != ".githooks" ] && [ "$FORCE" -ne 1 ]; then
  echo "guards:install: core.hooksPath is already '${CURRENT}'; installing would stop those hooks from running." >&2
  echo "  Re-run with --force to replace it." >&2
  exit 1
fi

mkdir -p "$HOOKS_DIR"
for name in guard-lib.sh pre-commit pre-push; do
  cp "$SOURCE_DIR/$name" "$HOOKS_DIR/$name"
  chmod 0755 "$HOOKS_DIR/$name"
done
git config core.hooksPath "$HOOKS_DIR"
git config clowder.guard.pushRepo "$IDENTITY"

echo "git guards installed for this clone and all of its worktrees (core.hooksPath=${HOOKS_DIR})"
echo "  pre-commit: refuses commits on main while origin is the upstream (${GUARD_UPSTREAM_IDENTITY})"
echo "  pre-push: refuses pushes to anything other than ${IDENTITY}"
echo "  Re-run after pulling changes to .githooks/; remove with: git config --unset core.hooksPath"
