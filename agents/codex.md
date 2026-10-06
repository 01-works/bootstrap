# Codex

## 설치

`Brewfile.main`의 `cask "codex"` → `/opt/homebrew/bin/codex`.

npm 전역 설치(`npm i -g @openai/codex`)는 Node 버전별로 따로 깔려서, fnm 기본 버전을 바꾸면 `codex`가 사라진다. 그래서 cask를 쓴다.

지금 Mac mini는 아직 npm 전역 설치를 쓰고 있다 (2026-10-06). fnm 경로가 PATH 앞에 있어서 cask를 깔아도 npm 쪽이 먼저 잡힌다. 옮기려면:

```sh
brew install --cask codex
npm uninstall -g @openai/codex
which codex   # /opt/homebrew/bin/codex 인지 확인
```

## 설정

| 파일 | 저장소 | 이유 |
|---|---|---|
| `~/.codex/AGENTS.md` | [링크](../home/codex/.codex/AGENTS.md) | 모든 프로젝트 공통 지시 |
| `~/.codex/config.toml` | [seed](../home/codex/.codex/config.toml.seed): 없을 때만 복사 | Codex가 이 파일에 계속 써넣는다 |
| `~/.codex/hooks.json` | 넣지 않음 | 지금 쓰는 훅이 설치 안 된 `workmux`를 부른다 |
| `auth.json`, 세션, 기록 | 넣지 않음 | 인증·기기 상태 |

### config.toml을 링크하지 않는 이유

지금 Mac mini의 `config.toml`(249줄) 중 약 100줄이 신뢰 폴더 목록(`[projects."/Users/yw/..."]`)이다. Codex가 새 폴더에서 실행될 때마다 추가하므로 기기마다 다르고, 링크하면 커밋할 때마다 의미 없는 변경이 생기고 프로젝트 경로가 저장소에 남는다. 플러그인 목록, ChatGPT 앱 내부 경로, `node_repl` MCP 설정도 앱이 관리한다.

seed에는 직접 고른 값만 넣었다: 모델, 추론 강도, 성격, 에이전트 수, 기능 플래그, 데스크톱 설정, Figma MCP.

seed를 바꿔도 이미 `config.toml`이 있는 기기에는 반영되지 않는다. 각 기기에서 직접 고친다.

## 로그인

```sh
codex login
```

## 별칭

`codexa`, `codexd` = `codex --dangerously-bypass-approvals-and-sandbox` ([terminal.md](../development/terminal.md))
