#!/usr/bin/env bash
# Saves the current productivity and break sheets into history/ so the dashboard can show trends.
# Run on a schedule by .github/workflows/snapshot.yml; safe to run by hand.
#
# Each snapshot is filed under the date of the data inside the sheet, not the date it was taken:
# the sheet holds the day's Ameyo report, which can lag behind the clock. Running more than once
# is fine: a day is rewritten only when the sheet content for that day changed.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD_URL='https://docs.google.com/spreadsheets/d/1ZU0r6Mr0WVz-AD65Jn3uPHsnnCO9ssDepIupeFmOwsA/export?format=csv'
BREAK_URL='https://docs.google.com/spreadsheets/d/17ortJZIjY3O08iVyW_nryiiOQlo6K0ielPSpL1oKtf8/export?format=csv'
DIR="${HISTORY_DIR:-history}"

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

# The day of the data: the most common dd/mm/yyyy in the break sheet's "Ready Start Time".
DAY="$(python3 - "$tmp/breaks.csv" <<'PY'
import collections, csv, re, sys
days = collections.Counter()
for row in csv.DictReader(open(sys.argv[1], encoding='utf-8-sig')):
    m = re.match(r'\s*(\d{1,2})/(\d{1,2})/(\d{4})', row.get('Ready Start Time') or '')
    if m:
        days['%s-%02d-%02d' % (m.group(3), int(m.group(2)), int(m.group(1)))] += 1
print(days.most_common(1)[0][0] if days else '')
PY
)"
if [ -z "$DAY" ]; then
  DAY="$(TZ=Asia/Kolkata date +%F)"
  echo "No dates found in the break sheet; filing under today's IST date $DAY." >&2
fi

# History is only trusted from this day on; earlier days are not kept.
FIRST_DAY='2026-11-05'
if [[ "$DAY" < "$FIRST_DAY" ]]; then
  echo "The sheet holds $DAY, before $FIRST_DAY; not saving."
  exit 0
fi

if cmp -s "$tmp/prod.csv" "$DIR/$DAY.csv" 2>/dev/null && cmp -s "$tmp/breaks.csv" "$DIR/$DAY-breaks.csv" 2>/dev/null; then
  echo "Sheet is unchanged for $DAY; nothing to save."
  exit 0
fi

cp "$tmp/prod.csv" "$DIR/$DAY.csv"
cp "$tmp/breaks.csv" "$DIR/$DAY-breaks.csv"

dates="$(ls "$DIR"/????-??-??.csv | xargs -n1 basename | sed 's/\.csv$//' | sort | sed 's/.*/"&"/' | paste -sd, -)"
printf '{"dates":[%s]}\n' "$dates" > "$DIR/index.json"
echo "Saved snapshot for $DAY"
