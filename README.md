# bootstrap

새 Mac을 받아서 내 작업 환경으로 만드는 저장소. 장비 고르기부터 macOS 초기 설정, 개발 도구, 코딩 에이전트까지.

## 새 Mac에서

1. 장비 고르기 → [hardware/buying-guide.md](hardware/buying-guide.md)
2. 첫 부팅과 손으로 할 설정 → [macos/initial-setup.md](macos/initial-setup.md)
3. 터미널을 열고 순서대로:

   ```sh
   xcode-select --install          # 설치 창이 뜨면 끝날 때까지 기다린다
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   eval "$(/opt/homebrew/bin/brew shellenv)"
   brew install gh
   gh auth login                   # 비공개 저장소라 clone 전에 로그인이 필요하다
   gh repo clone 01-works/bootstrap ~/dev/bootstrap
   cd ~/dev/bootstrap
   ./bootstrap.sh --profile main --dry-run   # 할 일 미리 보기
   ./bootstrap.sh --profile main
   ```

4. 새 터미널을 열고 `./bootstrap.sh doctor`가 모두 통과하는지 확인
5. 마지막에 출력되는 수동 설정 목록 처리 (Claude, Codex, Paseo 로그인, Tailscale 명령어 설치 등)

도구별 공식 문서와 설치 방법을 고른 이유는 [TOOLS.md](TOOLS.md). 설치가 실패하면 여기부터 본다.

## 프로필

기기마다 무엇을 설치하고 어떤 설정 파일을 둘지 [profiles/](profiles/)에서 고른다. 처음 한 번 `--profile`을 주면 기억한다.

| 프로필 | 기기 | 단계 | 설정 파일 |
|---|---|---|---|
| `main` | 메인 개발기 (지금은 Mac mini M4) | 전부 | zsh, git, claude, codex |
| `minimal` | 보조 기기 | preflight, xcode, homebrew, macos, auth | 없음 |

## 단계

`scripts/steps/`의 번호 순서대로 실행된다. 여러 번 실행해도 이미 된 것은 건너뛴다.

| 단계 | 하는 일 | 문서 |
|---|---|---|
| preflight | Apple Silicon·네트워크 확인, 이 저장소의 커밋 전 검사 켜기 | |
| xcode | Xcode 명령줄 도구 | |
| homebrew | Homebrew 설치, 프로필의 Brewfile 설치 | [development/homebrew.md](development/homebrew.md) |
| macos | 키보드, 다크 모드, Dock 설정 | [macos/system-settings.md](macos/system-settings.md) |
| power | 잠자기 끄기, 원격 접속 확인 (늘 켜두는 기기) | [hardware/mac-mini.md](hardware/mac-mini.md) |
| dotfiles | `home/`의 설정 파일을 `~`에 연결 | 아래 "설정 파일" |
| runtimes | Node(fnm) 기본 버전, pnpm | [development/node.md](development/node.md) |
| agents | Claude Code, Codex CLI 설치 (공식 스크립트) | [agents/](agents/README.md) |
| auth | GitHub 로그인, SSH 키, 비밀값 파일 | [development/git.md](development/git.md) |

## 자주 쓰는 명령

```sh
./bootstrap.sh --only dotfiles     # 한 단계만
./bootstrap.sh doctor              # 세팅 상태 검증
./bootstrap.sh snapshot            # 이 Mac에는 있는데 저장소에 없는 것 찾기
./bootstrap.sh --list              # 프로필별 단계
```

새 도구를 설치했으면 `snapshot`으로 확인하고 Brewfile에 옮겨 적는다. 그래야 다음 기기에도 깔린다.

## 새 기기 없이 시험하기

임시 HOME 폴더에서 설정 파일·Node·에이전트 단계를 실제로 실행해 볼 수 있다. 지금 Mac의 설정은 건드리지 않는다. Homebrew, macOS 설정, 인증 단계는 지금 Mac에 영향을 주므로 빼고 돌린다.

```sh
T=$(mktemp -d)
env -i HOME="$T" PATH=/usr/bin:/bin:/usr/sbin:/sbin TERM=xterm USER="$USER" \
  ./bootstrap.sh --profile main --only dotfiles,runtimes,agents
env -i HOME="$T" PATH=/usr/bin:/bin:/usr/sbin:/sbin TERM=xterm USER="$USER" ./bootstrap.sh doctor
rm -rf "$T"
```

## 설정 파일

- `home/<묶음>/`은 `~`과 같은 구조다. 파일 단위로 심볼릭 링크하므로 `~/.zshrc`를 고치면 바로 저장소에 반영된다 (`git diff`로 보임).
- `.seed`로 끝나는 파일은 대상이 없을 때만 복사한다. 도구가 스스로 고쳐 쓰는 파일(Codex `config.toml`)용.
- 기존 파일은 `~/.local/state/bootstrap/backup/<시각>/`으로 옮긴 뒤 연결한다.
- 기기마다 다른 설정은 `~/.zshrc.local`, `~/.gitconfig.local`에 둔다. 저장소에 넣지 않는다.
- 비밀값은 `~/.zsh_secrets`에 둔다 ([templates/zsh_secrets.example](templates/zsh_secrets.example)). 커밋 전에 gitleaks가 한 번 더 검사한다.
- 넣지 않는 것: 인증 파일(`auth.json`, gh `hosts.yml`), SSH 개인키, 각 도구의 세션·캐시·기록.

## 구조

```text
bootstrap.sh          진입점
Brewfile              모든 기기 공통 설치 목록
Brewfile.main         메인 개발기 추가분
TOOLS.md              도구별 공식 문서 링크, 설치 방법을 고른 이유
profiles/             기기별 단계·Brewfile·설정 파일 선택
home/                 ~에 연결할 설정 파일 (묶음별)
templates/            저장소 밖에 둘 파일의 템플릿
scripts/steps/        단계별 스크립트
scripts/doctor.sh     검증
scripts/snapshot.sh   저장소에 빠진 것 찾기
hardware/             장비 고르기, 기기별 기록
macos/                첫 부팅, 시스템 설정
development/          Homebrew, Node, git, 터미널, 컨테이너
agents/               코딩 에이전트별 설치·설정
```
