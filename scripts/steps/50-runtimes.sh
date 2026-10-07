#!/usr/bin/env bash
# Node(fnm) 기본 버전과 pnpm.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

# dry-run에서는 fnm이나 pnpm을 실행하지 않는다. 둘 다 파일을 만들거나 내려받을 수 있고, 새 Mac에서는 아직 fnm이 없다.
if [[ "$DRY_RUN" == 1 ]]; then
  info "[dry-run] fnm으로 Node $NODE_VERSION 설치·기본 버전 지정, corepack으로 pnpm 켜기"
  exit 0
fi

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
fnm use default >/dev/null

# pnpm은 corepack으로 관리한다. corepack이 없으면(Node 25부터는 Node에 들어 있지 않다) 전역으로 설치한다.
if has pnpm; then
  ok "pnpm $(pnpm --version 2>/dev/null)"
else
  has corepack || run npm install -g corepack
  run corepack enable pnpm
  ok "pnpm (corepack)"
fi
