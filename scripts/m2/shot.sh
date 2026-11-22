#!/usr/bin/env bash
# Copies the screenshots you took since the last import from the Windows screenshots folder into docs/m2-details/proofs/<id>/ (the originals stay where they are).
#   scripts/m2/shot.sh <proof-id> [label]        e.g.  scripts/m2/shot.sh 1.1        or   scripts/m2/shot.sh 1.7 incomplete-banner
# Take screenshots with Win+Shift+S (then they must be saved: Snipping Tool "Auto save", or use Win+PrintScreen, which saves to Pictures\Screenshots by itself).
# Files are named <id>-<label>-<n>.png (n counts up). SHOT_DIR overrides the folder, SINCE_MIN (default 30) is how far back to look the first time.
set -euo pipefail
ID=${1:?proof id, e.g. 1.1}; LABEL=${2:-shot}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SRC=${SHOT_DIR:-$(ls -d /mnt/c/Users/*/Pictures/Screenshots 2>/dev/null | head -1)}
[ -n "$SRC" ] && [ -d "$SRC" ] || { echo "Windows screenshots folder not found; set SHOT_DIR=/mnt/c/Users/<you>/Pictures/Screenshots" >&2; exit 1; }
dest=$ROOT/docs/m2-details/proofs/$ID; mkdir -p "$dest"; marker=$ROOT/docs/m2-details/proofs/.last-shot
if [ -f "$marker" ]; then newer=(-newer "$marker"); else newer=(-mmin "-${SINCE_MIN:-30}"); fi
mapfile -t files < <(find "$SRC" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' \) "${newer[@]}" -printf '%T@ %p\n' | sort -n | cut -d' ' -f2-)
[ "${#files[@]}" -gt 0 ] || { echo "no new screenshots in $SRC since the last import"; exit 0; }
n=$(find "$dest" -maxdepth 1 -name "$ID-$LABEL-*.png" | wc -l)
for f in "${files[@]}"; do n=$((n + 1)); ext=${f##*.}; out="$dest/$ID-$LABEL-$n.${ext,,}"; cp "$f" "$out"; echo "saved $(basename "$f") -> ${out#$ROOT/}"; done
touch "$marker"
