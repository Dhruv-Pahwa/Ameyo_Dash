#!/usr/bin/env bash
# Saves the current productivity and break sheets into history/ so the dashboard can show trends.
# Run nightly by .github/workflows/snapshot.yml; safe to run by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD_URL='https://docs.google.com/spreadsheets/d/1ZU0r6Mr0WVz-AD65Jn3uPHsnnCO9ssDepIupeFmOwsA/export?format=csv'
BREAK_URL='https://docs.google.com/spreadsheets/d/17ortJZIjY3O08iVyW_nryiiOQlo6K0ielPSpL1oKtf8/export?format=csv'
DIR="${HISTORY_DIR:-history}"
DAY="$(TZ=Asia/Kolkata date +%F)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$DIR"

curl -fsSL --retry 3 --retry-delay 5 "$PROD_URL" -o "$tmp/prod.csv"
curl -fsSL --retry 3 --retry-delay 5 "$BREAK_URL" -o "$tmp/breaks.csv"

# A sign-in page or an empty sheet is not a snapshot.
for f in prod breaks; do
  if [ "$(wc -l < "$tmp/$f.csv")" -lt 2 ] || head -c 300 "$tmp/$f.csv" | grep -qi '<html'; then
    echo "The $f sheet returned no data rows (is it still shared as 'anyone with the link'?)" >&2
    exit 1
  fi
done

# The sheet is overwritten daily: if it is identical to the last saved day, nothing new was loaded.
prev="$(ls "$DIR"/????-??-??.csv 2>/dev/null | grep -v "/$DAY.csv" | tail -1 || true)"
if [ -n "$prev" ] && cmp -s "$tmp/prod.csv" "$prev"; then
  echo "Sheet is unchanged since $prev; not saving a duplicate day."
  exit 0
fi

cp "$tmp/prod.csv" "$DIR/$DAY.csv"
cp "$tmp/breaks.csv" "$DIR/$DAY-breaks.csv"

dates="$(ls "$DIR"/????-??-??.csv | xargs -n1 basename | sed 's/\.csv$//' | sort | sed 's/.*/"&"/' | paste -sd, -)"
printf '{"dates":[%s]}\n' "$dates" > "$DIR/index.json"
echo "Saved snapshot for $DAY"
