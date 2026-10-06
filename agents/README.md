# 코딩 에이전트

| 도구 | 설치 | 저장소에 있는 설정 | 로그인 |
|---|---|---|---|
| [Claude Code](claude-code.md) | 공식 설치 스크립트 (`agents` 단계) | `CLAUDE.md`, `settings.json` (링크) | `claude` 실행 |
| Claude 앱 | `cask "claude"` | | 앱에서 |
| [Codex CLI](codex.md) | `cask "codex"` | `AGENTS.md` (링크), `config.toml` (seed) | `codex login` |
| ChatGPT 앱 | `cask "chatgpt"` | | 앱에서 |
| [Paseo](paseo.md) | `cask "paseo"` | | 앱에서 |
| opencode | `brew "anomalyco/tap/opencode"` | | |
| aider | `uv "aider-chat"` | | API 키 (`~/.zsh_secrets`) |
| CodexBar | `cask "steipete/tap/codexbar"` | | 메뉴 막대 사용량 표시 |
| [Cursor](cursor.md) | `cask "cursor"` (주석 처리됨) | | |
| [Anchor](anchor.md) | 확인 필요 | | |
| Hermes | 직접 설치 (`~/.hermes/hermes-agent`) | | |

## 정리가 필요한 것 (2026-10-06 지금 Mac mini)

- **openclaw**: `~/.local/bin/openclaw`가 `/opt/homebrew/opt/node@22`를 실행하는데 node@22가 설치되어 있지 않다. 지금은 실행되지 않는 상태로 보인다. 계속 쓸지 정해서 다시 설치하거나 지운다.
- **Codex 훅**: `~/.codex/hooks.json`이 `workmux set-window-status`를 부르는데 `workmux`가 설치되어 있지 않다. 그래서 저장소에 넣지 않았다.
- **Codex CLI**: npm 전역(fnm Node 24)으로 깔려 있다. `cask "codex"`로 옮긴 뒤 `npm uninstall -g @openai/codex`. 자세한 건 [codex.md](codex.md).

## 원칙

- 인증 파일, 세션, 기록, 캐시는 저장소에 넣지 않는다.
- 도구가 스스로 고쳐 쓰는 설정 파일은 링크하지 않고 `.seed`로 기본값만 둔다.
- 도구가 설치해 주는 스킬·플러그인(예: Paseo가 넣는 `~/.claude/skills/paseo-*`)은 그 도구가 관리하게 둔다.
