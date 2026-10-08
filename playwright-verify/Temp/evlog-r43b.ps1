$ErrorActionPreference = 'SilentlyContinue'
"--- WER operational log ---"
Get-WinEvent -FilterHashtable @{LogName='Windows Error Reporting'; StartTime=(Get-Date '2026-10-08 02:10'); EndTime=(Get-Date '2026-10-08 02:25')} |
  ForEach-Object {
    "==== $($_.TimeCreated.ToString('HH:mm:ss')) Id=$($_.Id) ===="
    (($_.Message -split "`r?`n") | Select-Object -First 12) -join "`n"
    ""
  }
"--- Application Error 02:00-02:30 ---"
Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'; StartTime=(Get-Date '2026-10-08 02:00'); EndTime=(Get-Date '2026-10-08 02:30')} |
  ForEach-Object { $_.TimeCreated.ToString('HH:mm:ss') + ' ' + (($_.Message -split "`r?`n")[0..4] -join ' | ') }
