#!/usr/bin/env bash
# 코딩 에이전트 CLI. 둘 다 공식 문서가 기본으로 안내하는 설치 스크립트를 쓴다.
# 둘 다 ~/.local/bin에 설치되고 스스로 업데이트된다. 근거: TOOLS.md
# 앱(Claude, ChatGPT, Paseo)은 Brewfile에서 설치된다. 로그인 안내는 auth 단계가 모아서 보여 준다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

export CODEX_NON_INTERACTIVE=1  # Codex 설치 끝에 "지금 실행할까요?"를 묻지 않게 한다

failed=0

# install_cli <명령> <설치 스크립트 주소> <실행할 셸>
# curl | sh는 받기에 실패해도 성공으로 끝나므로, 먼저 받아 두고 확인한 뒤 실행한다. 하나가 실패해도 다른 하나는 설치한다.
install_cli() {
  local cmd="$1" url="$2" shell="$3" script
  if has "$cmd"; then
    if cli_works "$cmd"; then
      ok "$cmd $("$cmd" --version 2>/dev/null | head -1)"
    else
      warn "$cmd 실행 실패: $(command -v "$cmd"). 기존 설치는 유지합니다. TOOLS.md의 공식 설치 방법으로 복구하세요"
      failed=1
    fi
    return 0
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    info "[dry-run] $url 을 받아서 $shell 로 실행"
    return 0
  fi
  if script="$(curl -fsSL "$url")" && printf '%s\n' "$script" | "$shell" && cli_works "$cmd"; then
    ok "$cmd 설치됨"
  else
    warn "$cmd 설치 실패. 다시: ./bootstrap.sh --only agents"
    failed=1
  fi
}

install_cli claude https://claude.ai/install.sh bash
install_cli codex https://chatgpt.com/codex/install.sh sh

if has paseo; then
  ok "paseo"
else
  warn "paseo 없음 (Brewfile의 cask \"paseo\" 확인)"
fi

exit "$failed"
