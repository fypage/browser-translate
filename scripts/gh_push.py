#!/usr/bin/env python3
"""通过 GitHub Git Data API 推送仓库内容（绕过 github.com:443 不通的问题）
token 只从环境变量读，绝不出现在任何输出里。
"""
import base64
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

TOKEN = os.environ.get("GITHUB_TOKEN", "")
if not TOKEN:
    sys.exit("missing GITHUB_TOKEN")
REPO = os.environ.get("GH_REPO", "fypage/browser-translate")
API = "https://api.github.com"
ROOT = pathlib.Path(os.environ.get("GH_DIR") or pathlib.Path(__file__).resolve().parent.parent)
SKIP_DIRS = {".git", "node_modules", "__pycache__"}
SKIP_SUFFIX = {".zip", ".log"}


def req(method, path, data=None):
    url = API + path
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, data=body, method=method)
    r.add_header("Authorization", "Bearer " + TOKEN)
    r.add_header("Accept", "application/vnd.github+json")
    r.add_header("User-Agent", "minis-translator")
    if body:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=90) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError("HTTP %s %s %s -> %s" % (e.code, method, path, detail))


def walk_files():
    out = []
    for p in sorted(ROOT.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        if p.suffix in SKIP_SUFFIX:
            continue
        out.append((rel.as_posix(), p))
    return out


def main():
    files = walk_files()
    print("files:", len(files))

    entries = []
    for rel, p in files:
        data = p.read_bytes()
        blob = req("POST", "/repos/%s/git/blobs" % REPO, {
            "content": base64.b64encode(data).decode(),
            "encoding": "base64",
        })
        entries.append({"path": rel, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print("  blob %-32s %6d B" % (rel, len(data)))

    tree = req("POST", "/repos/%s/git/trees" % REPO, {"tree": entries})
    print("tree:", tree["sha"])

    parents = []
    try:
        ref = req("GET", "/repos/%s/git/ref/heads/main" % REPO)
        parents = [ref["object"]["sha"]]
        print("existing head:", parents[0][:10])
    except RuntimeError:
        print("empty repo, first commit")

    msg = "译界 v1.0：整页双语对照 + 划词气泡的浏览器翻译扩展\n\n" \
          "- 五套引擎：必应（免费·国内直连·底层为 LLM）/ Google / DeepSeek / OpenAI 兼容 / DeepL\n" \
          "- 整页双语对照，懒加载，一键还原\n" \
          "- 划词气泡用 Shadow DOM 隔离\n" \
          "- 大模型引擎支持页面上下文注入与术语表\n" \
          "- 本地 LRU 缓存\n" \
          "- 修复 edge.microsoft.com/translate/auth 404 导致的引擎失效，改走 cn.bing.com"
    commit = req("POST", "/repos/%s/git/commits" % REPO, {
        "message": msg, "tree": tree["sha"], "parents": parents,
    })
    print("commit:", commit["sha"])

    if parents:
        req("PATCH", "/repos/%s/git/refs/heads/main" % REPO, {"sha": commit["sha"], "force": False})
    else:
        req("POST", "/repos/%s/git/refs" % REPO, {"ref": "refs/heads/main", "sha": commit["sha"]})
    print("pushed to main OK")
    print("https://github.com/%s" % REPO)


main()
