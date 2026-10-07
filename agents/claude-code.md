# Claude Code

## 설치

`agents` 단계가 공식 설치 스크립트로 설치한다. `~/.local/bin/claude`에 설치되고 스스로 업데이트된다. Homebrew cask(`claude-code`)는 자동 업데이트가 안 되고 최신보다 한 주쯤 늦어서 쓰지 않는다 ([TOOLS.md](../TOOLS.md)).

설치 상태 점검: `claude doctor`

## 설정

| 파일 | 저장소 | 내용 |
|---|---|---|
| `~/.claude/CLAUDE.md` | [링크](../home/claude/.claude/CLAUDE.md) | 모든 프로젝트 공통 지시 (한국어로 답하기) |
| `~/.claude/settings.json` | [링크](../home/claude/.claude/settings.json) | 모델, 권한, 알림 |
| `~/.claude/skills/` | 넣지 않음 | Paseo가 설치하는 스킬, 동기화되는 스킬 |
| 그 외 `~/.claude/*` | 넣지 않음 | 세션, 기록, 캐시, 플러그인 |

링크된 파일이라 Claude Code가 `settings.json`에 저장한 변경은 저장소에도 바로 반영된다. `git diff`로 확인하고 커밋한다.

Claude Code가 `settings.json`을 저장하면서 링크를 일반 파일로 바꿔 버릴 수도 있다. `./bootstrap.sh doctor`가 "링크가 아니라 일반 파일"이라고 알려주면, 바뀐 내용을 저장소 파일에 옮기고 `./bootstrap.sh --only dotfiles`로 다시 연결한다.

## 로그인

`claude`를 처음 실행하면 안내가 나온다.
