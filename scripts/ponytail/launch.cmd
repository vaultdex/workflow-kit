: <<'WINDOWS'
@echo off
"%~dp0launch.exe" %*
exit /b %errorlevel%
WINDOWS
exec /bin/sh "${0%/*}/launch.sh" "$@"
