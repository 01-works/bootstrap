#!/usr/bin/env bash
# Homebrew 설치 후 프로필의 Brewfile들을 설치한다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

# 설치 방법 근거: TOOLS.md (Homebrew)
if has brew; then
  ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"
else
  run /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ "$DRY_RUN" == 1 ]]; then
    info "Homebrew가 없어서 Brewfile 설치는 미리 볼 수 없습니다"
    exit 0
  fi
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
    warn "$f 일부 항목 설치 실패. 이미 직접 설치한 앱이면 development/homebrew.md의 '기존 앱 옮기기' 참고"
  fi
done
