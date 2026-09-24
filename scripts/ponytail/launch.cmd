: <<'WINDOWS'
@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File "%~dp0launch.ps1" %*
exit /b %errorlevel%
WINDOWS
exec /bin/sh "${0%/*}/launch.sh" "$@"
