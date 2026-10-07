#!/usr/bin/env bash
# 코딩 에이전트 CLI. 둘 다 공식 문서가 기본으로 안내하는 설치 스크립트를 쓴다.
# 둘 다 ~/.local/bin에 설치되고 스스로 업데이트된다. 근거: TOOLS.md
# 앱(Claude, ChatGPT, Paseo)은 Brewfile.main에서 설치된다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

if has claude; then
  ok "claude $(claude --version 2>/dev/null | head -1)"
else
  run bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
fi

if has codex; then
  ok "codex $(codex --version 2>/dev/null | head -1)"
else
  run sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
fi

if has paseo; then
  ok "paseo"
else
  warn "paseo 없음 (Brewfile.main 확인)"
fi

cat <<'EOF'

    로그인은 직접 해야 합니다:
      claude          처음 실행하면 로그인 안내
      codex           처음 실행하면 "Sign in with ChatGPT"
      Paseo 앱        실행 후 데몬 설정
      Claude·ChatGPT 앱
EOF
