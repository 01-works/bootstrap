# 코딩 에이전트

공식 문서 링크와 설치 방법을 고른 이유는 [TOOLS.md](../TOOLS.md). 저장소에 넣는 것과 넣지 않는 것의 원칙은 [README](../README.md#설정-파일).

| 도구 | 역할 | 설치 | 저장소에 있는 설정 | 로그인 |
|---|---|---|---|---|
| [Claude Code](claude-code.md) | 터미널·Paseo 코딩 작업, 지원되는 대화형 CLI의 GUI 작업 | 공식 설치 스크립트 (`agents` 단계) | `CLAUDE.md`, `settings.json` (링크) | `claude` 실행 |
| Claude 앱 | Cowork·데스크톱 Claude Code와 앱 GUI 작업 | `cask "claude"` | | 앱에서 |
| [Codex CLI](codex.md) | 터미널·Paseo 코딩 작업 | 공식 설치 스크립트 (`agents` 단계) | `AGENTS.md` (링크), `config.toml` (seed) | `codex` 실행 |
| ChatGPT 앱 (Codex 앱) | Work·Codex와 Computer Use 플러그인 | `cask "chatgpt"` | | 앱에서 |
| [Paseo](paseo.md) | 작업자·workspace 조율 | `cask "paseo"` | 프로필 (병합), `yw-supervisor` 스킬 (Claude·Codex에 링크) | 앱에서 |
| [브라우저 작업](browser.md) | 웹 UI·기존 Chrome은 Browser Use CLI 기본 | Chrome·uv·agent-browser (`homebrew` 단계) | 기본 Browser Use CLI(uv)·양쪽 공식 스킬, 기존 Chrome·Paseo 설정 (`browser` 단계) | 지정한 기존 Chrome 프로필의 로그인 사용 |

위 앱·CLI는 기존 bootstrap의 Homebrew·`agents`·`browser` 단계에서 이미 자동 설치한다. 앱 설치만으로 Computer Use가 활성화되거나 권한·동작 확인이 끝나지는 않는다. 제품·실행 환경별 지원 범위와 수동 절차는 [기기 GUI 작업](computer-use.md)에 모은다. Paseo 작업자의 GUI 도구 지원은 별도 확인이 필요하다.

## ChatGPT 앱과 Codex

- **앱**: Codex 데스크톱 앱은 2026-07부터 ChatGPT 앱에 합쳐졌다. ChatGPT 앱 하나만 설치하면 된다.
- **터미널용 Codex CLI는 따로 설치한다.** ChatGPT 앱 안에도 `codex` 실행 파일이 있지만 앱 내부용이라 터미널에서 쓸 수 없다. 공식 문서도 CLI 설치를 따로 안내한다. 터미널에서 `codex`를 쓰거나 Paseo가 Codex를 돌릴 때는 이 CLI가 필요하다.
