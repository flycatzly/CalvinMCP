$ErrorActionPreference = 'SilentlyContinue'
Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'; StartTime=(Get-Date '2026-10-06 00:00')} |
  ForEach-Object {
    $lines = $_.Message -split "`r?`n"
    "==== $($_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')) ===="
    ($lines | Select-Object -First 14) -join "`n"
    ""
  }
"--- .NET Runtime ID1026 (faulting assembly) ---"
Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1026; StartTime=(Get-Date '2026-10-06 00:00')} |
  ForEach-Object {
    $lines = $_.Message -split "`r?`n"
    "==== $($_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')) ===="
    ($lines | Select-Object -First 10) -join "`n"
    ""
  }
