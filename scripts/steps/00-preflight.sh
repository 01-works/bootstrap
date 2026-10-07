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
