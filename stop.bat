@echo off
chcp 65001 >nul
title 停止朗读
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9889/stop' -TimeoutSec 2 | Out-Null; Write-Host '已停止朗读' } catch { Write-Host '没在朗读（插件未启动或已经停了）' }"
timeout /t 1 >nul
