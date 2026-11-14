@echo off
rem Shortcut: bin\gateway status ^| start ^| stop ^| restart ^| logs ^| login ^| add-project NAME
cd /d "%~dp0.."
node proxy\cli.mjs %*
