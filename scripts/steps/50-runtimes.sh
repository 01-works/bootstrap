#!/usr/bin/env bash
# Node(fnm) 기본 버전, pnpm, Vercel CLI.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

# dry-run에서는 fnm이나 pnpm을 실행하지 않는다. 둘 다 파일을 만들거나 내려받을 수 있고, 새 Mac에서는 아직 fnm이 없다.
if [[ "$DRY_RUN" == 1 ]]; then
  info "[dry-run] fnm으로 Node $NODE_VERSION 설치·기본 버전 지정, pnpm 공식 설치 스크립트 실행, pnpm으로 Vercel CLI 설치"
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
  # 예전에 corepack으로 켠 pnpm이 남아 있는 기기. 프로젝트 영향이 있을 수 있어 자동으로 바꾸지 않고 알린다.
  if [[ "$(command -v pnpm)" == */fnm/* ]]; then
    warn "corepack으로 켠 pnpm을 쓰고 있습니다. 공식 설치 방식으로 바꾸는 법: development/node.md의 '기존 기기에서 corepack pnpm 바꾸기'"
  fi
else
  script="$(curl -fsSL https://get.pnpm.io/install.sh)" || die "pnpm 설치 스크립트를 받지 못했습니다"
  zdot="$(mktemp -d)"
  printf '%s\n' "$script" | ZDOTDIR="$zdot" SHELL=/bin/zsh sh -
  rm -rf "$zdot"
  has pnpm || die "pnpm이 설치되지 않았습니다"
  ok "pnpm $(pnpm --version) 설치됨"
fi

# Vercel CLI: 공식 문서의 pnpm 전역 설치. 자동 업데이트도 켠다(vercel upgrade --enable-auto).
# 실행 파일만 남고 패키지가 없는 경우가 있어서, 있는지가 아니라 실행되는지로 확인한다.
if vercel --version >/dev/null 2>&1; then
  ok "vercel $(vercel --version 2>/dev/null | tail -1)"
else
  run pnpm add -g vercel
  run vercel upgrade --enable-auto
  vercel --version >/dev/null 2>&1 || die "Vercel CLI가 실행되지 않습니다"
  ok "vercel 설치됨, 자동 업데이트 켬"
fi
