# 터미널

## zsh 파일 역할

| 파일 | 언제 읽나 | 내용 |
|---|---|---|
| [`.zprofile`](../home/zsh/.zprofile) | 로그인 셸 | PATH: Homebrew, fnm 기본 버전, `~/.local/bin` |
| [`.zshrc`](../home/zsh/.zshrc) | 대화형 셸 | 별칭, tmux 함수, bun·pnpm, fnm 자동 전환 |
| `~/.zsh_secrets` | `.zshrc`가 읽음 | API 키. 저장소 밖, 권한 600 |
| `~/.zshrc.local` | `.zshrc` 마지막 | 이 기기에만 필요한 설정. 저장소 밖 |

## 별칭

| 별칭 | 실행 |
|---|---|
| `clauded` | `claude --dangerously-skip-permissions` |
| `codexa`, `codexd` | `codex --dangerously-bypass-approvals-and-sandbox` |
| `code`, `vscode` | VS Code CLI |

## tmux

설정: [`.tmux.conf`](../home/tmux/.tmux.conf) (마우스 켬, 여러 클라이언트가 붙으면 가장 작은 화면에 맞춤)

| 함수 | 하는 일 |
|---|---|
| `tl [이름]` | 세션 붙기. 이름 없이 실행하면 fzf로 고른다. Ctrl-N은 입력한 이름으로 새로 만들기 |
| `td` | 지금 세션에서 빠져나오기 |
| `tk [이름]` | 세션 종료 (확인 후) |

원격에서는 `mosh`로 붙고 `tl`로 세션을 고르면 연결이 끊겨도 작업이 유지된다.

## 설치 도구가 `.zshrc`를 고쳐 쓰는 경우

`.zshrc`는 저장소 파일에 링크되어 있어서, 설치 스크립트가 줄을 추가하면 저장소 파일이 바뀐다. `git diff`로 확인하고 필요한 것만 남긴다.
