# 코딩 에이전트

공식 문서 링크와 설치 방법을 고른 이유는 [TOOLS.md](../TOOLS.md). 저장소에 넣는 것과 넣지 않는 것의 원칙은 [README](../README.md#설정-파일).

| 도구 | 역할 | 설치 | 저장소에 있는 설정 | 로그인 |
|---|---|---|---|---|
| [Claude Code](claude-code.md) | 터미널·Paseo 코딩 작업 | 공식 설치 스크립트 (`agents` 단계) | `CLAUDE.md` (링크), `settings.json` (초기값, 없을 때만 복사) | `claude` 실행 |
| Claude 앱 | Cowork·데스크톱 Claude Code | `cask "claude"` | | 앱에서 |
| [Codex CLI](codex.md) | 터미널·Paseo 코딩 작업 | 공식 설치 스크립트 (`agents` 단계) | `AGENTS.md` (링크), `config.toml` (seed) | `codex` 실행 |
| ChatGPT 앱 (Codex 앱) | Work·Codex | `cask "chatgpt"` | | 앱에서 |
| [Paseo](paseo.md) | 작업자·workspace 조율 | `cask "paseo"` | 프로필·도구 설정 (병합), 기본 플러그인 (목록 버전으로 맞춤), `yw-supervisor`·`yw-chief-supervisor`·`yw-paseo-cleanup` 스킬 (Claude·Codex에 링크) | 앱에서. 데스크톱은 `paseo-upgrade`가 한 시간마다 확인(최신 버전 조회는 하루 한 번) ([새 버전](paseo.md#paseo-새-버전)) |
| [공용 heavy 대기열](heavy-queue.md) | 무거운 명령을 기기에서 하나씩 실행 (감독 세션·worktree 공용) | `yw-heavy` (`heavy` 단계, `~/.local/bin`) | 원본 `scripts/yw-heavy.sh` | |
| [브라우저 작업](browser.md) | 에이전트 전용 Chrome(기본)·개인 Chrome(요청 시) 조작 | Chrome·Chrome Beta·uv (`homebrew` 단계), Browser Use CLI·공식 스킬 (`browser` 단계) | 에이전트 Chrome 자동 시작 | 에이전트 Chrome에 한 번씩 로그인 |

네이티브 앱 GUI 작업(Computer Use)은 앱 설치와 별개로 기기마다 활성화·권한 설정이 필요하다 → [기기 GUI 작업](computer-use.md).

## ChatGPT 앱과 Codex

- **앱**: Codex 데스크톱 앱은 2026-07부터 ChatGPT 앱에 합쳐졌다. ChatGPT 앱 하나만 설치하면 된다.
- **터미널용 Codex CLI는 따로 설치한다.** ChatGPT 앱 안에도 `codex` 실행 파일이 있지만 앱 내부용이라 터미널에서 쓸 수 없다. 공식 문서도 CLI 설치를 따로 안내한다. 터미널에서 `codex`를 쓰거나 Paseo가 Codex를 돌릴 때는 이 CLI가 필요하다.

## 메모리

Claude Code 자동 메모리와 Codex 메모리는 모든 기기에서 끈다. 기기마다 따로 쌓이고 두 도구가 공유하지 않아 같은 작업의 규칙이 달라진다. 기억할 내용은 해당 저장소의 지침·문서나 이슈에 남긴다(공통 지시에 같은 규칙).

- 끄기: `agents` 단계가 `scripts/agent-memory.mjs`로 `~/.claude/settings.json`의 `autoMemoryEnabled`를 `false`로 바꾸고 `codex features disable memories`를 실행한다. 이미 있는 설정 파일에서도 이 값과 [자동 요약](claude-code.md#자동-요약) 창만 바꾼다. Claude Code는 이 값이 `false`이면 메모리를 읽지도 쓰지도 않는다. 새 기기 초기값도 같다.
- ZeroSub 계정 홈: `settings.json`은 `~/.claude/settings.json`에서 생성되고 Codex `config.toml`은 링크라 따로 고치지 않는다. 계정별 설정(`settings.account.json`)에서 켠 값은 우선하므로 켜지 않는다.
- 적용 시점: 새 세션부터. 다시 켜진 기기는 `doctor`가 알리고 `./bootstrap.sh --only agents`로 끈다.
- 기존 메모리 파일은 지우지 않는다. 필요한 내용은 확인해서 저장소로 옮긴다.
