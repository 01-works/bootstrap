#!/usr/bin/env bash
# Node(fnm) 기본 버전과 pnpm.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

# dry-run에서는 fnm이나 pnpm을 실행하지 않는다. 둘 다 파일을 만들거나 내려받을 수 있고, 새 Mac에서는 아직 fnm이 없다.
if [[ "$DRY_RUN" == 1 ]]; then
  info "[dry-run] fnm으로 Node $NODE_VERSION 설치·기본 버전 지정, pnpm 공식 설치 스크립트 실행"
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

# pnpm: 공식 설치 스크립트로 Node와 따로 설치한다(~/Library/pnpm). 프로젝트마다 packageManager에 고정한 버전은
# pnpm이 알아서 받아 쓴다. 설치 스크립트는 셸 설정의 pnpm 줄을 이 기기의 절대 경로로 다시 쓰는데, ~/.zshrc는
# 저장소 파일에 링크되어 있고 같은 줄이 이미 들어 있다. 그래서 ZDOTDIR을 임시 폴더로 돌려 그 수정을 버린다.
if has pnpm; then
  ok "pnpm $(pnpm --version 2>/dev/null)"
else
  script="$(curl -fsSL https://get.pnpm.io/install.sh)" || die "pnpm 설치 스크립트를 받지 못했습니다"
  zdot="$(mktemp -d)"
  printf '%s\n' "$script" | ZDOTDIR="$zdot" SHELL=/bin/zsh sh -
  rm -rf "$zdot"
  has pnpm || die "pnpm이 설치되지 않았습니다"
  ok "pnpm $(pnpm --version) 설치됨"
fi
