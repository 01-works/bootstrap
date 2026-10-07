#!/usr/bin/env bash
# 코딩 에이전트. 대부분 Brewfile.main에서 설치되고, 여기서는 Claude Code 설치와 확인만 한다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

# Claude Code는 자동 업데이트되는 공식 설치 스크립트를 쓴다 (~/.local/bin/claude).
if has claude; then
  ok "claude $(claude --version 2>/dev/null | head -1)"
else
  run bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
fi

for cmd in codex paseo; do
  if has "$cmd"; then
    ok "$cmd"
  else
    warn "$cmd 없음 (Brewfile.main 확인)"
  fi
done

cat <<'EOF'

    로그인은 직접 해야 합니다:
      claude          처음 실행하면 로그인 안내
      codex login
      Paseo 앱        실행 후 데몬 설정
      Claude·ChatGPT 앱, CodexBar
      Hermes          직접 설치 (agents/hermes.md)
EOF
