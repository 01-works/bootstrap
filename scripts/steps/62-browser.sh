#!/usr/bin/env bash
# 개발 UI와 기존 Chrome 작업의 기본값은 Browser Use. 연결/승인은 이 단계에서 하지 않는다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

if [[ "$DRY_RUN" == 1 ]]; then
  info '[dry-run] Browser Use CLI가 없으면 uv로 설치, 공식 스킬을 양쪽 provider 경로에 충돌 검사 후 배치'
  info '[dry-run] Brewfile의 agent-browser CLI 확인, 공식 스킬을 Codex·Claude 양쪽에 설치'
  info '[dry-run] Chrome 승인형 디버깅과 Paseo Browser 설정 (Chrome 실행 중에는 해당 설정 안내)'
  exit 0
fi
node "$BOOTSTRAP_ROOT/scripts/browser-use-setup.mjs"

cli_works /opt/homebrew/bin/agent-browser || die 'Homebrew agent-browser 없음 또는 실행 실패. ./bootstrap.sh --only homebrew,browser 로 다시 실행하세요'
cli_works agent-browser || die 'PATH의 agent-browser 실행 실패. agents/browser.md의 설치 이전 방법을 확인하세요'
# fnm의 npm 전역 바이너리가 Homebrew보다 앞서면 새 Node에서 다시 사라질 수 있다.
if [[ "$(command -v agent-browser)" != /opt/homebrew/bin/agent-browser ]]; then
  die "다른 agent-browser가 Homebrew를 가립니다: $(command -v agent-browser). agents/browser.md의 설치 이전 방법을 확인하세요"
fi
ok "$(agent-browser --version) (Homebrew)"
# 기존 Chrome에 연결하므로 Chrome for Testing을 받는 `agent-browser install`은 실행하지 않는다.
agent_browser_claude_skill="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/agent-browser/SKILL.md"
if [[ -f "$HOME/.agents/skills/agent-browser/SKILL.md" && -f "$agent_browser_claude_skill" ]] &&
   cmp -s "$HOME/.agents/skills/agent-browser/SKILL.md" "$agent_browser_claude_skill"; then
  ok 'agent-browser 스킬 (Codex·Claude)'
else
  # 공식 설치기가 기존 개인 스킬을 덮어쓰지 않게 불완전/다른 설치는 보존한다.
  for path in "$HOME/.agents/skills/agent-browser" "$HOME/.claude/skills/agent-browser" \
              "${CODEX_HOME:-$HOME/.codex}/skills/agent-browser" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/agent-browser"; do
    [[ ! -e "$path" && ! -L "$path" ]] || die "기존 agent-browser 스킬 확인 필요: $path. 자동 재설치 없이 보존했습니다"
  done
  has npx || die 'npx 없음. ./bootstrap.sh --only runtimes,browser 로 다시 실행하세요'
  run npx --yes skills add vercel-labs/agent-browser --global --agent codex claude-code --skill agent-browser --yes
fi
node "$BOOTSTRAP_ROOT/scripts/browser-settings.mjs"
