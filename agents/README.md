# 코딩 에이전트

| 도구 | 설치 | 저장소에 있는 설정 | 로그인 |
|---|---|---|---|
| [Claude Code](claude-code.md) | 공식 설치 스크립트 (`agents` 단계) | `CLAUDE.md`, `settings.json` (링크) | `claude` 실행 |
| Claude 앱 | `cask "claude"` | | 앱에서 |
| [Codex CLI](codex.md) | `cask "codex"` | `AGENTS.md` (링크), `config.toml` (seed) | `codex login` |
| ChatGPT 앱 | `cask "chatgpt"` | | 앱에서. Codex 설정이 이 앱 안의 파일을 참조한다 |
| [Paseo](paseo.md) | `cask "paseo"` | | 앱에서 |
| CodexBar | `cask "steipete/tap/codexbar"` | | 메뉴 막대 사용량 표시 |
| [Hermes](hermes.md) | 직접 설치 | | |

## 원칙

- 인증 파일, 세션, 기록, 캐시는 저장소에 넣지 않는다.
- 도구가 스스로 고쳐 쓰는 설정 파일은 링크하지 않고 `.seed`로 기본값만 둔다.
- 도구가 설치해 주는 스킬·플러그인(예: Paseo가 넣는 `~/.claude/skills/paseo-*`)은 그 도구가 관리하게 둔다.
