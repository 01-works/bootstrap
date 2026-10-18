#!/usr/bin/env bash
# 개발 검증은 Paseo Browser, 기존 Chrome 인증·탭 작업은 agent-browser.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

if [[ "$DRY_RUN" == 1 ]]; then
  info '[dry-run] Brewfile의 agent-browser CLI 확인, 공식 스킬을 Codex·Claude 양쪽에 설치'
  info '[dry-run] Chrome 승인형 디버깅과 Paseo Browser 설정 (Chrome 실행 중에는 해당 설정 안내)'
  exit 0
fi
cli_works /opt/homebrew/bin/agent-browser || die 'Homebrew agent-browser 없음 또는 실행 실패. ./bootstrap.sh --only homebrew,browser 로 다시 실행하세요'
cli_works agent-browser || die 'PATH의 agent-browser 실행 실패. agents/browser.md의 설치 이전 방법을 확인하세요'
# fnm의 npm 전역 바이너리가 Homebrew보다 앞서면 새 Node에서 다시 사라질 수 있다.
if [[ "$(command -v agent-browser)" != /opt/homebrew/bin/agent-browser ]]; then
  die "다른 agent-browser가 Homebrew를 가립니다: $(command -v agent-browser). agents/browser.md의 설치 이전 방법을 확인하세요"
fi
ok "$(agent-browser --version) (Homebrew)"
# 기존 Chrome에 연결하므로 Chrome for Testing을 받는 `agent-browser install`은 실행하지 않는다.
if [[ -f "$HOME/.agents/skills/agent-browser/SKILL.md" && -f "$HOME/.claude/skills/agent-browser/SKILL.md" ]] &&
   cmp -s "$HOME/.agents/skills/agent-browser/SKILL.md" "$HOME/.claude/skills/agent-browser/SKILL.md"; then
  ok 'agent-browser 스킬 (Codex·Claude)'
else
  has npx || die 'npx 없음. ./bootstrap.sh --only runtimes,browser 로 다시 실행하세요'
  run npx --yes skills add vercel-labs/agent-browser --global --agent codex claude-code --skill agent-browser --yes
fi
node "$BOOTSTRAP_ROOT/scripts/browser-settings.mjs"
