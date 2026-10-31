# 코딩 에이전트

공식 문서 링크와 설치 방법을 고른 이유는 [TOOLS.md](../TOOLS.md). 저장소에 넣는 것과 넣지 않는 것의 원칙은 [README](../README.md#설정-파일).

| 도구 | 역할 | 설치 | 저장소에 있는 설정 | 로그인 |
|---|---|---|---|---|
| [Claude Code](claude-code.md) | 터미널·Paseo 코딩 작업 | 공식 설치 스크립트 (`agents` 단계) | `CLAUDE.md`, `settings.json` (링크) | `claude` 실행 |
| Claude 앱 | Cowork·데스크톱 Claude Code | `cask "claude"` | | 앱에서 |
| [Codex CLI](codex.md) | 터미널·Paseo 코딩 작업 | 공식 설치 스크립트 (`agents` 단계) | `AGENTS.md` (링크), `config.toml` (seed) | `codex` 실행 |
| ChatGPT 앱 (Codex 앱) | Work·Codex | `cask "chatgpt"` | | 앱에서 |
| [Paseo](paseo.md) | 작업자·workspace 조율 | `cask "paseo"` | 프로필·도구 설정 (병합), 기본 플러그인 (목록 버전으로 맞춤), `yw-supervisor` 스킬 (Claude·Codex에 링크) | 앱에서. 데스크톱은 `paseo-upgrade`가 한 시간마다 확인(최신 버전 조회는 하루 한 번) ([새 버전](paseo.md#paseo-새-버전)) |
| [공용 heavy 대기열](heavy-queue.md) | 무거운 명령을 기기에서 하나씩 실행 (감독 세션·worktree 공용) | `yw-heavy` (`heavy` 단계, `~/.local/bin`) | 원본 `scripts/yw-heavy.sh` | |
| [브라우저 작업](browser.md) | 에이전트 전용 Chrome(기본)·개인 Chrome(요청 시) 조작 | Chrome·Chrome Beta·uv (`homebrew` 단계), Browser Use CLI·공식 스킬 (`browser` 단계) | 에이전트 Chrome 자동 시작 | 에이전트 Chrome에 한 번씩 로그인 |

네이티브 앱 GUI 작업(Computer Use)은 앱 설치와 별개로 기기마다 활성화·권한 설정이 필요하다 → [기기 GUI 작업](computer-use.md).

## ChatGPT 앱과 Codex

- **앱**: Codex 데스크톱 앱은 2026-07부터 ChatGPT 앱에 합쳐졌다. ChatGPT 앱 하나만 설치하면 된다.
- **터미널용 Codex CLI는 따로 설치한다.** ChatGPT 앱 안에도 `codex` 실행 파일이 있지만 앱 내부용이라 터미널에서 쓸 수 없다. 공식 문서도 CLI 설치를 따로 안내한다. 터미널에서 `codex`를 쓰거나 Paseo가 Codex를 돌릴 때는 이 CLI가 필요하다.
