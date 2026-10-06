#!/usr/bin/env bash
# 시작 전 확인: macOS + Apple Silicon인지, 네트워크가 되는지.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

[[ "$(uname -s)" == Darwin ]] || die "macOS 전용입니다"
[[ "$(uname -m)" == arm64 ]] || die "Apple Silicon 전용입니다 (Homebrew 경로를 /opt/homebrew로 가정)"
ok "macOS $(sw_vers -productVersion) / $(sysctl -n machdep.cpu.brand_string)"

if curl -fsI --max-time 10 https://github.com >/dev/null 2>&1; then
  ok "네트워크"
else
  die "github.com에 연결할 수 없습니다"
fi

# 이 저장소의 커밋 전 비밀값 검사(.githooks/pre-commit)를 켠다.
if git -C "$BOOTSTRAP_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  if [[ "$(git -C "$BOOTSTRAP_ROOT" config core.hooksPath || true)" == .githooks ]]; then
    ok "git hooks (.githooks)"
  else
    run git -C "$BOOTSTRAP_ROOT" config core.hooksPath .githooks
    ok "git hooks 켬 (.githooks)"
  fi
fi
