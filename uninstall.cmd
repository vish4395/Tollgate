@echo off
cd /d "%~dp0"
node proxy\cli.mjs uninstall %*
