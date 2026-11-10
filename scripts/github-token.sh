#!/bin/sh
# GitHub token 领取 / 自检脚本
# 用法：
#   sh github-token.sh open    # 打开已预勾选 scope 的 token 创建页
#   sh github-token.sh check   # 检查当前 GITHUB_TOKEN 是否可用
#   sh github-token.sh push    # 用当前 token 把项目推到 GitHub
#
# 说明：token 本身永远不会被打印。所有读取都只输出 HTTP 状态与权限名。

DESC="yijie-browser-translate"
REPO="fypage/browser-translate"
CREATE_URL="https://github.com/settings/tokens/new?description=${DESC}&scopes=repo"
FINE_URL="https://github.com/settings/personal-access-tokens/new?name=${DESC}&description=browser+translate+extension"

say() { printf '%s\n' "$*"; }

case "$1" in

open)
  say "创建 Classic token（scopes 已预勾选 repo）："
  say "  $CREATE_URL"
  say ""
  say "想要最小权限就用 fine-grained（需要手动选仓库 ${REPO}、给 Contents: Read and write）："
  say "  $FINE_URL"
  say ""
  if command -v android-open >/dev/null 2>&1; then
    if android-open "$CREATE_URL" >/dev/null 2>&1; then
      say "→ 已在系统浏览器打开，点最下面的 Generate token 即可。"
    else
      say "→ 没能自动打开，请手动复制上面的链接。"
    fi
  else
    say "→ 当前环境没有 android-open，请手动打开。"
  fi
  say ""
  say "拿到 token 后（形如 ghp_xxx）填到："
  say "  Minis → 设置 → 环境变量 → 新建 GITHUB_TOKEN"
  ;;

check)
  if [ -z "$GITHUB_TOKEN" ]; then
    say "✗ GITHUB_TOKEN 未设置"
    say "  去 设置 → 环境变量 添加，然后重开一个会话让我读到。"
    exit 1
  fi

  code=$(curl -s -o /tmp/gh_user.json -w '%{http_code}' --max-time 20 \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    https://api.github.com/user)

  if [ "$code" != "200" ]; then
    say "✗ token 无效或已撤销（HTTP $code）"
    rm -f /tmp/gh_user.json
    exit 1
  fi

  login=$(python3 -c "import json;print(json.load(open('/tmp/gh_user.json')).get('login',''))" 2>/dev/null)
  say "✓ token 有效，账号：${login}"

  # 只读取权限名，不输出 token
  scopes=$(curl -sI --max-time 20 -H "Authorization: Bearer $GITHUB_TOKEN" \
    https://api.github.com/user 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="x-oauth-scopes"{print $2}')
  if [ -n "$scopes" ]; then
    say "  权限范围：$scopes"
    case "$scopes" in
      *repo*) say "  ✓ 含 repo，可以推送" ;;
      *) say "  ✗ 不含 repo，推送会失败" ;;
    esac
  else
    say "  （fine-grained token，无 scope 列表，改用仓库探测）"
  fi

  rcode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}")
  say "  仓库读取：HTTP ${rcode}$([ "$rcode" = "200" ] && echo ' ✓' || echo ' ✗')"
  rm -f /tmp/gh_user.json
  ;;

push)
  sh "$(dirname "$0")/gh_push.py" || exit 1
  ;;

*)
  say "用法：sh github-token.sh open|check|push"
  exit 1
  ;;
esac
