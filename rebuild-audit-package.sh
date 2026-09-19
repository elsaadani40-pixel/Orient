#!/data/data/com.termux/files/usr/bin/bash

set -u

OUT="ORIENT-ONE-AUDIT-PACKAGE.md"

{
  echo "# ORIENT ONE — PRINCIPAL ARCHITECT AUDIT PACKAGE"
  echo
  echo "Generated from the CURRENT filesystem."
  echo "This package is intended for external architectural review."
  echo
  echo "## PROJECT STRUCTURE"
  echo
  find . -type f \
    ! -path './.git/*' \
    ! -path './node_modules/*' \
    ! -name 'ORIENT-ONE-AUDIT-PACKAGE.md' \
    ! -name 'orient.log' \
    | sort
  echo
  echo "============================================================"
  echo "## SOURCE FILES"
  echo "============================================================"
} > "$OUT"

find . -type f \
  ! -path './.git/*' \
  ! -path './node_modules/*' \
  ! -name 'ORIENT-ONE-AUDIT-PACKAGE.md' \
  ! -name 'orient.log' \
  | sort | while read -r file; do

    echo >> "$OUT"
    echo "# FILE: ${file#./}" >> "$OUT"
    echo '```' >> "$OUT"
    cat "$file" >> "$OUT"
    echo >> "$OUT"
    echo '```' >> "$OUT"

done

echo >> "$OUT"
echo "============================================================" >> "$OUT"
echo "# END OF AUDIT PACKAGE" >> "$OUT"

echo
echo "=============================================="
echo "ORIENT ONE AUDIT PACKAGE REBUILT"
echo "=============================================="
echo "File: $(pwd)/$OUT"
echo "Size: $(wc -c < "$OUT") bytes"
echo "Lines: $(wc -l < "$OUT")"
echo
echo "===== MISSING FILE MARKERS ====="

if grep -q '\[FILE NOT FOUND' "$OUT"; then
    grep '\[FILE NOT FOUND' "$OUT"
else
    echo "NONE"
fi

echo
echo "===== FILE COUNT ====="
grep -c '^# FILE:' "$OUT"
