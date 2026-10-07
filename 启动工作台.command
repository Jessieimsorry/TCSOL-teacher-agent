#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  echo "需要 Node.js 24 或更新版本。请先安装 Node.js。"
  read -r "?按回车关闭"
  exit 1
fi
if [[ ! -d node_modules ]]; then
  npm ci || { read -r "?依赖安装失败，按回车关闭"; exit 1; }
fi
if curl -fsS http://127.0.0.1:8790/api/health 2>/dev/null | /usr/bin/grep -q 'ChineseTeachingTeam'; then
  open http://127.0.0.1:8790
  exit 0
fi
if /usr/sbin/lsof -nP -iTCP:8790 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "8790 端口被其他程序占用，请先停止该程序。"
  read -r "?按回车关闭"
  exit 1
fi
npm run build || { read -r "?构建失败，按回车关闭"; exit 1; }
(sleep 3; open http://127.0.0.1:8790) &
echo "关闭此窗口或按 Control+C 可以停止工作台。"
npm start
read -r "?工作台已停止，按回车关闭"
