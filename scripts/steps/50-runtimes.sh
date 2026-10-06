#!/usr/bin/env bash
# Node(fnm) 기본 버전과 pnpm. bun, uv, rust는 Brewfile.main에서 설치된다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

NODE_VERSION=24

has fnm || die "fnm이 없습니다. homebrew 단계를 먼저 실행하세요"
eval "$(fnm env --shell bash)"

# 파이프에 grep -q를 쓰면 fnm이 출력 도중 끊겨 실패로 잡히므로 출력을 먼저 받아 둔다.
versions="$(fnm list 2>/dev/null || true)"
if grep "v$NODE_VERSION\." <<<"$versions" >/dev/null; then
  ok "Node $NODE_VERSION 설치됨"
else
  run fnm install "$NODE_VERSION"
fi
if grep -E "v$NODE_VERSION\..* default" <<<"$versions" >/dev/null; then
  ok "fnm 기본 버전: $NODE_VERSION"
else
  run fnm default "$NODE_VERSION"
  ok "fnm 기본 버전을 $NODE_VERSION 으로"
fi
[[ "$DRY_RUN" == 1 ]] || fnm use default >/dev/null

# pnpm은 corepack으로 관리한다. Node 25부터 corepack이 빠지므로 전역으로 따로 설치해 둔다.
if has pnpm; then
  ok "pnpm $(pnpm --version 2>/dev/null)"
else
  has corepack || run npm install -g corepack
  run corepack enable pnpm
  ok "pnpm (corepack)"
fi

for cmd in bun uv cargo; do
  if has "$cmd"; then
    ok "$cmd $("$cmd" --version 2>/dev/null | head -1)"
  else
    warn "$cmd 없음 (Brewfile.main 확인)"
  fi
done
