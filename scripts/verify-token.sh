#!/bin/sh
# 验证 GITHUB_TOKEN 是否够用来推这个仓库
# 用法：sh scripts/verify-token.sh
# 原则：绝不打印 token 本身，只报告能力。

REPO="${GH_REPO:-fypage/browser-translate}"
API="https://api.github.com"

if [ -z "$GITHUB_TOKEN" ]; then
  echo "✗ GITHUB_TOKEN 未设置"
  echo "  → 在 Minis 里设置：Settings → 环境变量，键名 GITHUB_TOKEN"
  exit 1
fi

# 只检查存在性和长度区间，不打印内容
_len=$(printf '%s' "$GITHUB_TOKEN" | wc -c | tr -d ' ')
case "$GITHUB_TOKEN" in
  ghp_*) _kind="classic PAT" ;;
  github_pat_*) _kind="fine-grained PAT" ;;
  *) _kind="未知格式" ;;
esac
echo "· token 格式：$_kind，长度 ${_len}"

json_get() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }

# 1) 身份
_login=$(curl -s --max-time 20 -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" "$API/user" | json_get "d.get('login','')")
if [ -z "$_login" ]; then
  echo "✗ 认证失败 —— token 无效或已被撤销"
  exit 1
fi
echo "· 身份：$_login"

# 2) 仓库读权限 + push 能力
_body=$(curl -s --max-time 20 -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" "$API/repos/$REPO")
_repo=$(printf '%s' "$_body" | json_get "d.get('full_name','')")
_perm=$(printf '%s' "$_body" | json_get "str((d.get('permissions') or {}).get('push'))")

if [ -z "$_repo" ]; then
  echo "✗ 读不到 $REPO（不存在或 token 无权访问）"
  exit 1
fi
echo "· 仓库：$_repo"
if [ "$_perm" != "True" ]; then
  echo "✗ 没有写权限（permissions.push=$_perm）"
  echo "  → classic token 需要勾 repo；fine-grained 需要该仓库的 Contents: Read and write"
  exit 1
fi
echo "· 写权限：有"

# 3) 分支现状
_head=$(curl -s --max-time 20 -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" "$API/repos/$REPO/git/ref/heads/main" | json_get "d.get('object',{}).get('sha','')[:10]")
echo "· main 最新提交：${_head:-（空仓库）}"

echo ""
echo "✓ 这个 token 可以推 $REPO"
