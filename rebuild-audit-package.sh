#!/usr/bin/env bash

set -euo pipefail

OUT="ORIENT-ONE-AUDIT-PACKAGE.md"
TMP_LIST="$(mktemp)"
trap 'rm -f "$TMP_LIST"' EXIT

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: run this script from a Git working tree." >&2
  exit 1
fi

# Only package tracked project files. Never sweep arbitrary local files into
# an audit bundle: the working tree may contain credentials or private data.
git ls-files -z > "$TMP_LIST"

is_excluded() {
  local file="$1"
  case "$file" in
    .env|.env.*) [[ "$file" != ".env.example" ]] && return 0 ;;
    data|data/*|secrets|secrets/*|node_modules|node_modules/*|.git|.git/*) return 0 ;;
    *.pem|*.key|*.p12|*.pfx|*.crt|*.log|*.tmp|*.sqlite|*.sqlite-*|*.db) return 0 ;;
    *secret*|*credential*|*token-dump*|*memory-dump*|*customer-data*) return 0 ;;
    ORIENT-ONE-AUDIT-PACKAGE*.md) return 0 ;;
  esac
  return 1
}

mapfile -d '' -t tracked_files < "$TMP_LIST"
safe_files=()
for file in "${tracked_files[@]}"; do
  if ! is_excluded "$file"; then
    safe_files+=("$file")
  fi
done

{
  echo "# ORIENT ONE — ARCHITECTURE AUDIT PACKAGE"
  echo
  echo "Generated only from tracked repository files."
  echo "Local runtime data, secrets, environment files, and generated bundles are excluded."
  echo "Review this package before sharing; exclusions are defense-in-depth, not a guarantee."
  echo
  echo "## INCLUDED FILES"
  printf '%s\n' "${safe_files[@]}" | sort
  echo
  echo "============================================================"
  echo "## FILE CONTENTS"
  echo "============================================================"
} > "$OUT"

for file in "${safe_files[@]}"; do
  # A tracked file can still contain accidentally committed sensitive material.
  # Never assume that tracking alone makes a file safe to publish.
  {
    echo
    echo "# FILE: $file"
    echo '~~~'
    cat -- "$file"
    echo
    echo '~~~'
  } >> "$OUT"
done

echo
echo "Audit package rebuilt: $PWD/$OUT"
echo "Files included: ${#safe_files[@]}"
echo "Size: $(wc -c < "$OUT") bytes"
echo "Lines: $(wc -l < "$OUT")"
echo
echo "IMPORTANT: manually review the package for confidential material before sharing."
