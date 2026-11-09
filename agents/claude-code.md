# Claude Code

## 설치

`agents` 단계가 공식 설치 스크립트로 설치한다. `~/.local/bin/claude`에 설치되고 스스로 업데이트된다. Homebrew cask(`claude-code`)는 자동 업데이트가 안 되고 최신보다 한 주쯤 늦어서 쓰지 않는다 ([TOOLS.md](../TOOLS.md)).

설치 상태 점검: `claude doctor`

## 설정

| 파일 | 저장소 | 내용 |
|---|---|---|
| `~/.claude/CLAUDE.md` | [링크](../home/claude/.claude/CLAUDE.md) | 모든 프로젝트 공통 지시 (한국어, 브라우저·GUI 작업 원칙). Codex `AGENTS.md`와 같은 파일 |
| `~/.claude/settings.json` | [초기 기본값](../home/claude/.claude/settings.json.seed) | 모델, 권한, 알림. 기기 로컬 일반 파일 |
| `~/.claude/skills/` | 넣지 않음 | Paseo·Browser Use가 설치하는 스킬, 동기화되는 스킬. 직접 만든 스킬만 `agents/skills/`에서 링크 |
| 그 외 `~/.claude/*` | 넣지 않음 | 세션, 기록, 캐시, 플러그인 |

`settings.json.seed`는 새 기기에 설정 파일이 없을 때만 복사한다. 기존 일반 파일은 그대로 두며, Claude Code가 저장하는 설정·플러그인 변경은 이 기기에만 남는다. 기존 기기 사이의 자동 설정 동기화는 끝난다. 공통 초기 기본값을 바꾸려면 seed를 직접 고쳐 커밋한다. 기존 기기에 전파하려는 값은 각 기기의 로컬 파일에 따로 적용한다.

기존 링크는 이 변경을 받은 자동 갱신의 `dotfiles` 단계(또는 `./bootstrap.sh --only dotfiles`)에서 한 번 전환한다. 링크 대상의 현재 내용을 `~/.local/state/bootstrap/backup/<시각>-<번호>/.claude/settings.json`에 일반 파일로 백업하고, 같은 내용의 로컬 일반 파일로 교체한다. 갱신 직후 이름 변경으로 끊긴 기존 저장소 링크는 내용이 동일한 seed에서 복사한다. 모델·권한·테마 값은 바꾸지 않는다. 기존 링크를 통해 저장소에 실제 값 변경이 남아 있으면 자동 갱신은 계속 보류하므로, 먼저 그 변경을 보존·정리해야 한다.

내용을 되돌리려면 백업을 로컬 `~/.claude/settings.json`에 복사한다. 링크 방식까지 되돌리려면 저장소를 이전 버전으로 복구하고 현재 로컬 파일을 별도 백업한 뒤 `dotfiles` 단계를 실행한다.

## 로그인

`claude`를 처음 실행하면 안내가 나온다.
