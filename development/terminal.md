# 터미널

## zsh 파일 역할

| 파일 | 언제 읽나 | 내용 |
|---|---|---|
| [`.zprofile`](../home/zsh/.zprofile) | 로그인 셸 | PATH: Homebrew, fnm 기본 버전, `~/.local/bin` |
| [`.zshrc`](../home/zsh/.zshrc) | 대화형 셸 | 별칭, pnpm, fnm 자동 전환, 명령어 자동 완성 |
| `~/.zsh_secrets.infisical` | `.zshrc`가 먼저 읽음 | 여러 기기 공용 API 키. `secrets` 단계가 Infisical에서 받아 쓴다. 직접 고치지 않음, 권한 600 ([README](../README.md#비밀값)) |
| `~/.zsh_secrets` | `.zshrc`가 그다음 읽음 | 기기별 API 키. 같은 이름이면 공용 값보다 우선. 저장소 밖, 권한 600 |
| `~/.zshrc.local` | `.zshrc` 마지막 | 이 기기에만 필요한 설정. 저장소 밖 |

## 별칭

| 별칭 | 실행 |
|---|---|
| `clauded` | `claude --dangerously-skip-permissions` |
| `codexa`, `codexd` | `codex --dangerously-bypass-approvals-and-sandbox` |

## 설치 도구가 `.zshrc`를 고쳐 쓰는 경우

`.zshrc`는 저장소 파일에 링크되어 있어서, 설치 스크립트가 줄을 추가하면 저장소 파일이 바뀐다. `git diff`로 확인하고 필요한 것만 남긴다.
