# PowerShell script to extract data from CSV files and generate data.js
$scriptDir = "c:\Users\Dhruv Pahwa\Downloads\Ameyo_Dash"
$files = @(
    @{ Name = "8thOct.csv"; Label = "8th October" },
    @{ Name = "9thOct.csv"; Label = "9th October" },
    @{ Name = "10thOct.csv"; Label = "10th October" },
    @{ Name = "12thOct.csv"; Label = "12th October" }
)

$columns = @(
    "Campaign Name",
    "User Name",
    "Total Staffed Duration",
    "Auto Call-On Duration",
    "Auto Call-Off Duration",
    "Manual Calls Talk Time",
    "Total Break Duration"
)

$datasets = @()

foreach ($file in $files) {
    $fpath = Join-Path $scriptDir $file.Name
    if (-not (Test-Path $fpath)) {
        Write-Host "Warning: $($file.Name) not found, skipping"
        continue
    }
    
    $csv = Import-Csv $fpath
    $rows = @()
    
    foreach ($row in $csv) {
        $processName = $row.'Process Name'
        $userName = $row.'User Name'
        
        if ($processName -eq 'Campaign Summary' -or [string]::IsNullOrWhiteSpace($userName)) {
            continue
        }
        
        $extracted = @{}
        foreach ($col in $columns) {
            $val = $row.$col
            if ([string]::IsNullOrWhiteSpace($val)) { $val = "00:00:00" }
            $extracted[$col] = $val
        }
        $rows += $extracted
    }
    
    $datasets += @{
        fileName = $file.Name
        dateLabel = $file.Label
        rows = $rows
    }
    
    Write-Host "Processed $($file.Name): $($rows.Count) agent rows"
}

$json = $datasets | ConvertTo-Json -Depth 10 -Compress
$output = "// Auto-generated data file`nconst BUNDLED_DATA = $json;`n"

$outPath = Join-Path $scriptDir "data.js"
[System.IO.File]::WriteAllText($outPath, $output, [System.Text.Encoding]::UTF8)

Write-Host "`nGenerated data.js ($($output.Length) bytes) with $($datasets.Count) datasets"
