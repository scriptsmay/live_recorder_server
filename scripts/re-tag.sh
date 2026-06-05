#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
重新给 git 打标签脚本
用法:
  re-tag.sh -t <tag> [-m <msg>] [--push] [--force]
  re-tag.sh -d <tag> [--push]

选项:
  -t, --tag     要创建或更新的标签名（例如 v1.4.4）
  -m, --msg     标签注释（用于 -a 创建带注释的标签）
  --push        将本地变更推送到 origin
  --force       对远程执行强制覆盖（git push -f）
  -d, --delete  删除本地及远程标签
  -h, --help    显示此帮助

提示:
  如果标签打错，推荐先删除再推送：
    git tag -d <tag>
    git push origin --delete <tag>
  然后重新创建并推送；如果确实需要覆盖远程，可以使用 --force，但请谨慎。
EOF
}

if [ $# -eq 0 ]; then
  usage
  exit 1
fi

TAG=""
MSG=""
PUSH=false
FORCE=false
DELETE=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    -t|--tag)
      TAG="$2"; shift 2;;
    -m|--msg)
      MSG="$2"; shift 2;;
    --push)
      PUSH=true; shift;;
    --force)
      FORCE=true; shift;;
    -d|--delete)
      DELETE=true; TAG="$2"; shift 2;;
    -h|--help)
      usage; exit 0;;
    *)
      echo "未知选项: $1" >&2; usage; exit 2;;
  esac
done

if [ -z "$TAG" ]; then
  echo "标签名不能为空。" >&2; usage; exit 2
fi

if [ "$DELETE" = true ]; then
  echo "删除本地标签: $TAG"
  git tag -d "$TAG" || true
  if [ "$PUSH" = true ]; then
    if [ "$FORCE" = true ]; then
      echo "强制删除远程标签: $TAG"
      git push origin --delete "$TAG" || true
    else
      echo "删除远程标签: $TAG"
      git push origin --delete "$TAG" || true
    fi
  fi
  exit 0
fi

# 创建或更新标签
if [ -n "$MSG" ]; then
  echo "创建带注释标签: $TAG -> $MSG"
  git tag -a "$TAG" -m "$MSG"
else
  echo "创建轻量标签: $TAG"
  git tag -f "$TAG"
fi

if [ "$PUSH" = true ]; then
  if [ "$FORCE" = true ]; then
    echo "推送并强制覆盖远程标签: $TAG"
    git push origin "$TAG" -f
  else
    echo "推送标签到远程: $TAG"
    git push origin "$TAG"
  fi
fi

echo "完成: $TAG"
