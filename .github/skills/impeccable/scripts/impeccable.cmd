@echo off
setlocal
set "owned_stage="
rem Impeccable launcher (Windows). Runs bin\windows-<arch>\impeccable.exe next
rem to this file, else a cached or freshly downloaded engine binary.
rem
rem Structure notes:
rem - No multi-line parenthesized blocks: cmd expands %var% at block parse
rem   time, which made the old download path read back empty %url%/%cached%.
rem   Linear goto flow keeps every expansion on its own line, and avoids
rem   delayed expansion eating ! characters in user arguments.
rem - The unversioned user binary is validated with
rem   the engine-probe handshake (see :probe) so the retired 3.x npm CLI,
rem   whose bin is also named impeccable, is never exec'd. IMPECCABLE_BIN,
rem   the sibling binary, and the version-pinned cache stay trusted.
rem - Downloads are verified against repository SHA256SUMS via certutil and
rem   fail closed: a missing pin or hash tool refuses the download. On
rem   ARM64 the arm64 asset is tried first and the x64 asset is the
rem   fallback (Windows on ARM runs x64 binaries).
if not defined IMPECCABLE_SKILL_DIR set "IMPECCABLE_SKILL_DIR=%~dp0.."
if not defined IMPECCABLE_SELF set "IMPECCABLE_SELF=%~f0"
set "arch=x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "arch=arm64"

if not defined IMPECCABLE_BIN goto no_env_bin
if not exist "%IMPECCABLE_BIN%" goto no_env_bin
set "run=%IMPECCABLE_BIN%"
goto run
:no_env_bin

set "bin=%~dp0bin\windows-%arch%\impeccable.exe"
if not exist "%bin%" goto no_sibling
set "run=%bin%"
goto run
:no_sibling

set "home_bin=%USERPROFILE%\.impeccable\bin\impeccable.exe"
if not exist "%home_bin%" goto no_home_bin
if defined IMPECCABLE_LAUNCHER_PROBE goto no_home_bin
call :probe "%home_bin%"
if not "%probe_ok%"=="1" goto no_home_bin
set "run=%home_bin%"
goto run
:no_home_bin

set "version="
if exist "%~dp0VERSION" set /p version=<"%~dp0VERSION"
if not defined IMPECCABLE_HOME set "IMPECCABLE_HOME=%USERPROFILE%\.impeccable"
set "cached=%IMPECCABLE_HOME%\bin\%version%\impeccable.exe"
if not defined version goto no_cache
if not exist "%cached%" goto no_cache
set "run=%cached%"
goto run
:no_cache

:download
rem Last resort: fetch this version's binary from the release channel into
rem the version-pinned user cache, verify it, then run it. Never inside
rem another launcher's probe: fail fast and quiet instead.
if defined IMPECCABLE_LAUNCHER_PROBE goto abort
if not defined version goto fail
rem Never search the checkout or PATH for executable tools.
if not exist "%SystemRoot%\System32\curl.exe" goto curl_missing
if not defined IMPECCABLE_DOWNLOAD_BASE set "IMPECCABLE_DOWNLOAD_BASE=https://github.com/pbakaus/impeccable/releases/download"
if exist "%IMPECCABLE_HOME%\bin\%version%\" goto cache_ready
mkdir "%IMPECCABLE_HOME%\bin\%version%" >nul 2>nul
if errorlevel 1 if not exist "%IMPECCABLE_HOME%\bin\%version%\" goto cache_directory_failed
:cache_ready
rem Atomically reserve a private directory; never share another session's staging files.
:reserve_stage
set "stage=%cached%.stage-%RANDOM%-%RANDOM%"
mkdir "%stage%" >nul 2>nul
if errorlevel 1 if exist "%stage%\" goto reserve_stage
if errorlevel 1 goto cache_write_failed
set "owned_stage=1"
set "staged=%stage%\engine.part"
rem Check the staging file too: an existing directory may be read-only.
rem Redirection failures do not reliably update ERRORLEVEL in cmd.exe;
rem branch on the command's failure directly. Never treat a directory as a
rem staging file (later del cleanup would prompt to delete its contents).
if exist "%staged%\" goto cache_write_failed
(type nul >"%staged%") 2>nul || goto cache_write_failed
set "asset=impeccable-windows-%arch%.exe"
set "url=%IMPECCABLE_DOWNLOAD_BASE%/engine-v%version%/%asset%"
"%SystemRoot%\System32\curl.exe" -fsSL -o "%staged%" "%url%" >nul 2>nul
if not errorlevel 1 goto verify
if not "%arch%"=="arm64" goto download_failed
set "asset=impeccable-windows-x64.exe"
set "url=%IMPECCABLE_DOWNLOAD_BASE%/engine-v%version%/%asset%"
"%SystemRoot%\System32\curl.exe" -fsSL -o "%staged%" "%url%" >nul 2>nul
if errorlevel 1 goto download_failed

:verify
call :check_download
if errorlevel 1 goto abort
rem The expected digest is reviewed with the launcher, not fetched from its server.
set "expected="
for /f "usebackq tokens=1,2" %%h in ("%~dp0SHA256SUMS") do if "%%i"=="%asset%" set "expected=%%h"
if not defined expected goto verify_refuse
call :check_download
if errorlevel 1 goto abort
set "actual="
rem Check certutil's status before parsing: its error text is not a digest.
"%SystemRoot%\System32\certutil.exe" -hashfile "%staged%" SHA256 >"%staged%.sha256" 2>nul
if errorlevel 1 goto verify_refuse
call :check_download
if errorlevel 1 goto abort
for /f "usebackq skip=1 delims=" %%h in ("%staged%.sha256") do if not defined actual set "actual=%%h"
del "%staged%.sha256" >nul 2>nul
if not defined expected goto verify_refuse
if not defined actual goto verify_refuse
set "actual=%actual: =%"
if /I "%actual%"=="%expected%" goto place
del "%staged%" >nul 2>nul
echo impeccable: checksum mismatch downloading %url% 1>&2
call :cleanup
exit /b 127

:verify_refuse
call :check_download
if errorlevel 1 goto abort
del "%staged%" >nul 2>nul
del "%staged%.sha256" >nul 2>nul
echo impeccable: cannot verify %url% against repository SHA256SUMS; refusing the unverified download 1>&2
call :cleanup
exit /b 127

:check_download
set "download_file=%~1"
if not defined download_file set "download_file=%staged%"
if not exist "%download_file%" goto download_missing
for %%f in ("%download_file%") do if %%~zf==0 goto download_empty
exit /b 0

:download_missing
del "%staged%.sha256" >nul 2>nul
echo impeccable: download completed but the file was removed before execution: %url%; check your antivirus quarantine or logs. Refusing to continue; do not disable protection. 1>&2
call :cleanup
exit /b 127

:download_empty
del "%download_file%" >nul 2>nul
del "%staged%.sha256" >nul 2>nul
echo impeccable: downloaded file is empty: %url%; refusing the unverified download 1>&2
call :cleanup
exit /b 127

:place
call :check_download
if errorlevel 1 goto abort
move /y "%staged%" "%cached%" >nul 2>nul
if errorlevel 1 goto place_failed
call :check_download "%cached%"
if errorlevel 1 goto abort
set "run=%cached%"
goto run

:place_failed
rem Another session may have published and started the same binary already.
rem Reuse it only after comparing its bytes with our reviewed pin.
set "actual="
"%SystemRoot%\System32\certutil.exe" -hashfile "%cached%" SHA256 >"%staged%.sha256" 2>nul
if errorlevel 1 goto place_refused
for /f "usebackq skip=1 delims=" %%h in ("%staged%.sha256") do if not defined actual set "actual=%%h"
set "actual=%actual: =%"
if /I not "%actual%"=="%expected%" goto place_refused
set "run=%cached%"
goto run
:place_refused
call :check_download
if errorlevel 1 goto abort
del "%staged%" >nul 2>nul
echo impeccable: could not cache the verified download: %url% 1>&2
call :cleanup
exit /b 127

:run
call :cleanup
"%run%" %*
exit /b

:probe
rem Sets probe_ok=1 when %1 answers the engine handshake: prints
rem "impeccable-engine <version>" and exits 0. The 3.x npm CLI answers any
rem unknown verb with "Unknown command", exit 1, so it never passes.
set "probe_ok="
set "probe_tmp=%TEMP%\impeccable-probe-%RANDOM%%RANDOM%.txt"
set "IMPECCABLE_LAUNCHER_PROBE=1"
"%~1" engine-probe >"%probe_tmp%" 2>nul
set "probe_err=%ERRORLEVEL%"
set "IMPECCABLE_LAUNCHER_PROBE="
if not "%probe_err%"=="0" goto probe_done
"%SystemRoot%\System32\findstr.exe" /b /c:"impeccable-engine" "%probe_tmp%" >nul 2>nul
if not errorlevel 1 set "probe_ok=1"
:probe_done
del "%probe_tmp%" >nul 2>nul
exit /b 0

:cache_directory_failed
echo impeccable: engine %version% is not installed; cannot create cache directory: "%IMPECCABLE_HOME%\bin\%version%" 1>&2
goto setup_failed

:cache_write_failed
echo impeccable: engine %version% is not installed; cannot write to cache directory: "%IMPECCABLE_HOME%\bin\%version%" 1>&2
goto setup_failed

:curl_missing
echo impeccable: cannot download engine %version%; curl.exe is unavailable. 1>&2
goto setup_failed

:download_failed
del "%staged%" >nul 2>nul
echo impeccable: could not download engine %version% from %url%; check network access and the release URL. 1>&2

:setup_failed
echo Engine %version% setup needs network access and write permission to "%IMPECCABLE_HOME%\bin\%version%". 1>&2
echo Run this launcher ("%~f0") with engine-probe in a terminal that has those permissions, then retry the original command. 1>&2
echo Alternatively, set IMPECCABLE_HOME to a writable cache location, or IMPECCABLE_BIN to a preinstalled engine binary. 1>&2
call :cleanup
exit /b 127

:fail
echo impeccable: no engine binary found (looked in %bin%, %cached%). 1>&2
echo Download impeccable-windows-%arch%.exe from https://github.com/pbakaus/impeccable/releases (tag engine-v%version%) and save it as %cached%, or set IMPECCABLE_BIN to a preinstalled engine binary. Docs: https://impeccable.style 1>&2
call :cleanup
exit /b 127

:abort
call :cleanup
exit /b 127

:cleanup
if not defined owned_stage exit /b 0
del "%staged%" "%staged%.sha256" >nul 2>nul
rmdir "%stage%" >nul 2>nul
set "owned_stage="
exit /b 0
