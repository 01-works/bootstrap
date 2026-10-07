#!/usr/bin/env bash
# docker CLI 플러그인(compose, buildx) 연결. Homebrew로 설치한 플러그인은 docker가 기본 위치에서 찾지 못한다.
# Homebrew 안내는 ~/.docker/config.json의 cliPluginsExtraDirs지만, 로그인 정보가 든 그 파일을 고치지 않으려고
# colima FAQ 방식(~/.docker/cli-plugins 심볼릭 링크)을 쓴다. TOOLS.md 참고.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

src_dir="${HOMEBREW_PREFIX:-/opt/homebrew}/lib/docker/cli-plugins"
dst_dir="$HOME/.docker/cli-plugins"

for plugin in docker-compose docker-buildx; do
  src="$src_dir/$plugin"
  dst="$dst_dir/$plugin"
  if [[ ! -e "$src" ]]; then
    warn "$plugin 없음 (Brewfile.main 확인)"
    continue
  fi
  if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
    ok "$plugin"
    continue
  fi
  [[ -d "$dst_dir" ]] || run mkdir -p "$dst_dir"
  run ln -sfn "$src" "$dst"
  ok "$plugin 연결"
done
