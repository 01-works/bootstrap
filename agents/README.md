# 코딩 에이전트

공식 문서 링크와 설치 방법을 고른 이유는 [TOOLS.md](../TOOLS.md).

| 도구 | 설치 | 저장소에 있는 설정 | 로그인 |
|---|---|---|---|
| [Claude Code](claude-code.md) | 공식 설치 스크립트 (`agents` 단계) | `CLAUDE.md`, `settings.json` (링크) | `claude` 실행 |
| Claude 앱 | `cask "claude"` | | 앱에서 |
| [Codex CLI](codex.md) | 공식 설치 스크립트 (`agents` 단계) | `AGENTS.md` (링크), `config.toml` (seed) | `codex` 실행 |
| ChatGPT 앱 (Codex 앱) | `cask "chatgpt"` | | 앱에서 |
| [Paseo](paseo.md) | `cask "paseo"` | | 앱에서 |

## ChatGPT 앱과 Codex

- **앱**: Codex 데스크톱 앱은 2026-07부터 ChatGPT 앱에 합쳐졌다. ChatGPT 앱 하나만 설치하면 된다.
- **터미널용 Codex CLI는 따로 설치한다.** ChatGPT 앱 안에도 `codex` 실행 파일이 있지만 앱 내부용이라 터미널에서 쓸 수 없다. 공식 문서도 CLI 설치를 따로 안내한다. 터미널에서 `codex`를 쓰거나 Paseo가 Codex를 돌릴 때는 이 CLI가 필요하다.

## 원칙

- 인증 파일, 세션, 기록, 캐시는 저장소에 넣지 않는다.
- 도구가 스스로 고쳐 쓰는 설정 파일은 링크하지 않고 `.seed`로 기본값만 둔다.
- 도구가 설치해 주는 스킬·플러그인(예: Paseo가 넣는 `~/.claude/skills/paseo*`, `~/.agents/skills/paseo*`)은 그 도구가 관리하게 둔다.
