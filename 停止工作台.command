#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
ctt_pidfile="$HOME/Library/Application Support/ChineseTeachingTeam/server.pid"
if [[ -f "$ctt_pidfile" ]]; then
  ctt_pid=$(cat "$ctt_pidfile")
  if [[ "$ctt_pid" == <-> ]] && ps -p "$ctt_pid" -o command= | /usr/bin/grep -q 'server/index.ts' && /usr/sbin/lsof -nP -a -p "$ctt_pid" -iTCP:8790 -sTCP:LISTEN >/dev/null 2>&1; then
    kill -TERM "$ctt_pid"
    echo "工作台已停止，课程与任务已保留。"
  else
    echo "未发现此工作台的运行服务，无需停止。"
  fi
else
  echo "工作台未启动。"
fi
read -r "?按回车关闭"
