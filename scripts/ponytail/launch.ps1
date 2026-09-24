param(
  [ValidateSet('activate', 'subagent', 'mode-tracker')][string]$Action,
  [ValidateSet('codex', 'claude', 'copilot', 'cursor')][string]$HostName,
  [string]$Resume = ''
)
$ErrorActionPreference = 'Stop'
# Resolve junctions and file symlinks through Windows itself, before starting Node.
if (-not ('PonytailNativePath' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PonytailNativePath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);
  public static string Resolve(string path) {
    using (var file = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (file.IsInvalid) throw new System.ComponentModel.Win32Exception();
      var result = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandle(file, result, (uint)result.Capacity, 0);
      if (length == 0 || length >= result.Capacity) throw new System.ComponentModel.Win32Exception();
      string value = result.ToString();
      return value.StartsWith(@"\\?\UNC\") ? @"\\" + value.Substring(8) : value.Substring(4);
    }
  }
}
'@
}
$root = [PonytailNativePath]::Resolve((Get-Location).Path)
while (-not (Test-Path -LiteralPath (Join-Path $root '.git'))) {
  $parent = [IO.Directory]::GetParent($root)
  if ($null -eq $parent) { throw 'Ponytail: no checkout root found' }
  $root = $parent.FullName
}
$prefix = $root.TrimEnd('\') + '\'
$node = $null
foreach ($directory in ($env:PATH -split ';')) {
  if ($directory -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)') { continue }
  try {
    $candidate = [IO.Path]::GetFullPath((Join-Path $directory 'node.exe'))
    if ($candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $actual = [PonytailNativePath]::Resolve($candidate)
    if ($actual.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $node = $actual
    break
  } catch { continue }
}
if (-not $node) { throw 'Ponytail: install Node outside the checkout on an absolute PATH' }
Remove-Item Env:NODE_OPTIONS, Env:NODE_PATH -ErrorAction SilentlyContinue
& $node (Join-Path $PSScriptRoot ".agents/hooks/ponytail-$Action.js") $HostName $root $Resume
exit $LASTEXITCODE
