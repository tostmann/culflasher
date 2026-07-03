#!/usr/bin/env bash
# Install the tracked git hooks into .git/hooks (hooks aren't versioned by git
# itself, so re-run this after a fresh clone).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install -m 0755 "$root/scripts/hooks/pre-push" "$root/.git/hooks/pre-push"
echo "installed: .git/hooks/pre-push"
