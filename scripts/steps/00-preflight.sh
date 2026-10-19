#!/usr/bin/env bash
# 시작 전 확인: macOS + 지원 CPU인지, 네트워크가 되는지.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

[[ "$(uname -s)" == Darwin ]] || die "macOS 전용입니다"
case "$(uname -m)" in
  arm64) ;;
  x86_64) warn "Intel Mac: Homebrew Tier 3 환경입니다. 일부 도구는 소스 빌드가 필요할 수 있습니다" ;;
  *) die "64비트 Intel 또는 Apple Silicon Mac이 필요합니다" ;;
esac
ok "macOS $(sw_vers -productVersion) / $(sysctl -n machdep.cpu.brand_string)"

if curl -fsI --max-time 10 https://github.com >/dev/null 2>&1; then
  ok "네트워크"
else
  die "github.com에 연결할 수 없습니다"
fi
