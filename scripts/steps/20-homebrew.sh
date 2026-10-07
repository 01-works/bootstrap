#!/usr/bin/env bash
# Homebrew 설치 후 프로필의 Brewfile들을 설치한다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

# 설치 방법 근거: TOOLS.md (Homebrew)
if has brew; then
  ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"
elif [[ "$DRY_RUN" == 1 ]]; then
  info "[dry-run] Homebrew 공식 설치 스크립트 실행"
  info "Homebrew가 없어서 Brewfile 설치는 미리 볼 수 없습니다"
  exit 0
else
  # curl | bash는 받기에 실패해도 성공으로 끝나므로, 먼저 받아 두고 확인한 뒤 실행한다.
  installer="$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || die "Homebrew 설치 스크립트를 받지 못했습니다"
  /bin/bash -c "$installer"
  [[ -x /opt/homebrew/bin/brew ]] || die "Homebrew가 설치되지 않았습니다"
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# 하나가 실패해도(예: brew 밖에서 깔린 같은 앱) 나머지 단계는 계속한다. 빠진 항목은 doctor가 알려준다.
# --no-upgrade: 이미 깔린 건 업그레이드하지 않는다. 다시 실행해도 아무것도 바뀌지 않게.
for f in $BREWFILES; do
  info "brew bundle: $f"
  if [[ "$DRY_RUN" == 1 ]]; then
    brew bundle check --file="$BOOTSTRAP_ROOT/$f" --no-upgrade --verbose 2>&1 | grep '→' | sed 's/^/      /' || true
  fi
  if ! run brew bundle --file="$BOOTSTRAP_ROOT/$f" --no-upgrade; then
    warn "$f 일부 항목 설치 실패. 실패해도 이미 설치된 것은 바뀌지 않는다"
    info "이미 직접 설치한 앱이면: development/homebrew.md의 '기존 앱 옮기기'"
    info "다운로드 실패(404 등)면: 하루쯤 뒤 ./bootstrap.sh --only homebrew, 급하면 TOOLS.md의 공식 링크에서 받기"
  fi
done
