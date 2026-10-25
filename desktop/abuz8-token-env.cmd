@echo off
:: Sets OPENCLAW_GATEWAY_TOKEN in the CALLER's scope from the sovereign config.
:: Used by OPC1-CLI.cmd. An existing token in the environment wins.
::
:: The token is written to a temp file rather than captured with a
:: `for /f (` backtick: cmd mis-parses the parenthesised node invocation inside
:: the backtick form and fails with "The filename, directory name, or volume
:: label syntax is incorrect". Reading a file with for/f has no such quoting
:: hazard, and the file is removed immediately after.
setlocal EnableDelayedExpansion
if defined OPENCLAW_GATEWAY_TOKEN goto :done
set "TMPTKN=%TEMP%\opc1-token-%RANDOM%.txt"
"%~dp0..\runtime\node\node.exe" "%~dp0abuz8-gateway-token.cjs" "%USERPROFILE%\.openclaw-OPC-1\home\openclaw.json" > "!TMPTKN!" 2>nul
set "TKN="
if exist "!TMPTKN!" set /p TKN=<"!TMPTKN!"
del "!TMPTKN!" >nul 2>&1
endlocal & set "OPENCLAW_GATEWAY_TOKEN=%TKN%"
:done
