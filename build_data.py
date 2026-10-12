# build_data.py - Extracts required columns from CSV files and generates a JS data file
import csv
import json
import os
import sys

COLUMNS = [
    'Campaign Name',
    'User Name',
    'Total Staffed Duration',
    'Auto Call-On Duration',
    'Auto Call-Off Duration',
    'Manual Calls Talk Time',
    'Total Break Duration'
]

FILES = {
    '8thOct.csv': '8th October',
    '9thOct.csv': '9th October',
    '10thOct.csv': '10th October',
}

script_dir = os.path.dirname(os.path.abspath(__file__))
datasets = []

for fname, date_label in FILES.items():
    fpath = os.path.join(script_dir, fname)
    if not os.path.exists(fpath):
        print(f"Warning: {fname} not found, skipping")
        continue
    
    rows = []
    with open(fpath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            # Skip Campaign Summary rows and rows without a user name
            process_name = row.get('Process Name', '')
            user_name = row.get('User Name', '')
            if process_name == 'Campaign Summary' or not user_name:
                continue
            
            extracted = {}
            for col in COLUMNS:
                extracted[col] = row.get(col, '00:00:00')
            rows.append(extracted)
    
    datasets.append({
        'fileName': fname,
        'dateLabel': date_label,
        'rows': rows
    })
    print(f"Processed {fname}: {len(rows)} agent rows")

# Write as JS
output = f"// Auto-generated data file\nconst BUNDLED_DATA = {json.dumps(datasets, indent=None)};\n"

out_path = os.path.join(script_dir, 'data.js')
with open(out_path, 'w', encoding='utf-8') as f:
    f.write(output)

print(f"\nGenerated data.js ({len(output)} bytes) with {len(datasets)} datasets")
