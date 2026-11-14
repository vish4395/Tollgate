@echo off
rem Windows: install and start the gateway (see README).
cd /d "%~dp0"
node proxy\cli.mjs install %*
