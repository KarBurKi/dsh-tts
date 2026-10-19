@echo off
chcp 65001 >nul
REM 要玩大型游戏之前双击这个：掐掉正在读的，并把 GSV 进程全收掉，显存还回去。
REM 下次要朗读时插件会自己重新拉起模型（冷启动几十秒）。
echo 正在释放显存...
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://127.0.0.1:9889/release'; $r.Content } catch { '插件没在跑，或者没监听 9889' }"
timeout /t 3 >nul
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader 2>nul
