# bootstrap

새 Mac을 받아서 내 작업 환경으로 만드는 저장소. macOS 초기 설정, 개발 도구, 코딩 에이전트까지.

## 새 Mac에서

고를 것 없이 정해진 값으로 진행한다. 사람이 할 일은 본인 확인(비밀번호·로그인·macOS 권한 허용)뿐이다. 순서와 값은 [macos/initial-setup.md](macos/initial-setup.md).

1. **첫 부팅**: 언어, Wi-Fi, Apple 계정, FileVault(노트북만) (5분)
2. **한 줄 설치**: Apple Silicon·Intel Mac 모두 같은 한 줄을 터미널에 붙여 넣는다. 처음에 관리자 비밀번호를 한 번 묻고, 끝날 때 GitHub 로그인을 연다 (20~30분)

   ```sh
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/01-works/bootstrap/main/install.sh)"
   ```

3. **로그인**: 설치가 끝나며 열어 준 앱과 Chrome Beta(에이전트 전용)에 로그인, 터미널에서 `claude`·`codex` 첫 실행 (10분)
4. **화면 설정**: 새 터미널에서 `~/dev/bootstrap/bootstrap.sh doctor`. 실패·대기를 해결하고 마지막의 "직접 확인할 것"을 처리한다 (5분)

한 줄 설치는 Xcode 명령줄 도구(설치 창 없이)부터 저장소 받기(`~/dev/bootstrap`), 모든 단계, 최종 doctor까지 이어서 한다. 중간에 멈추면 같은 한 줄을 다시 실행한다. 이미 받은 기기에서는 저장소를 갱신(fast-forward)한 뒤 실행한다. 할 일만 보려면 끝에 ` install --dry-run`, 다른 위치에 받으려면 앞에 `BOOTSTRAP_DIR=<경로>`를 붙인다.

도구별 공식 문서와 설치 방법을 고른 이유는 [TOOLS.md](TOOLS.md). 설치가 실패하면 여기부터 본다.

브라우저 작업은 [Browser Use](agents/browser.md), 네이티브 앱 GUI 작업은 [Computer Use](agents/computer-use.md)를 쓴다. Computer Use는 앱 설치와 별개로 기기마다 활성화·권한 설정이 필요하다.

## 모든 기기가 같은 세팅

직접 쓰는 노트북이든 늘 켜두는 데스크톱이든 같은 것을 설치하고 같은 설정 파일을 연결한다. 기기마다 다른 것은 다섯 가지뿐이다.

- 전원: `power` 단계가 배터리 유무로 판단해서, 노트북은 충전 중에만 잠들지 않게 하고 데스크톱은 늘 켜둔다(화면은 가만히 있으면 끈다).
- 자동 시작: 데스크톱은 로그인할 때 Paseo 데몬과 에이전트 Chrome을 띄운다. 노트북은 필요할 때 시작한다.
- 재시동 복구: 데스크톱은 FileVault를 끄고 자동 로그인을 켜서 정전 뒤에도 혼자 켜지고 로그인한다. 노트북은 FileVault를 켠다.
- 로그인하는 계정 (GitHub, Google, Claude, Codex): 기기마다 로그인한다.
- git 커밋 작성자: 다른 GitHub 계정을 쓰는 기기는 `~/.gitconfig.local`에 이름·이메일을 적는다.

## 단계

`scripts/steps/`의 번호 순서대로 실행된다. 여러 번 실행해도 이미 된 것은 건너뛴다.

preflight, xcode, Homebrew 자체 설치가 실패하면 멈춘다. Brewfile 일부 항목 실패와 나머지 단계 실패는 모아 두고 다음 단계로 진행한다. 마지막에 실패한 단계와 재실행 명령을 보여 주며 최종 doctor 실패도 종료 코드에 반영한다.

종료 코드 `0`은 완료, `1`은 실패, `2`는 수동 작업 대기다. 예를 들어 데스크톱의 화면 공유가 꺼져 있거나 FileVault가 켜져 있으면 대기로 표시한다. 실패와 대기가 함께 있으면 `1`을 반환한다. 전체 실행에서는 수동 작업을 마친 뒤 최종 doctor까지 통과해야 완료다.

| 단계 | 하는 일 | 문서 |
|---|---|---|
| preflight | Apple Silicon/Intel·네트워크 확인 | |
| xcode | Xcode 명령줄 도구(git 포함), 이 저장소의 커밋 전 검사 켜기 | |
| homebrew | Homebrew 설치, Brewfile 설치, Intel용 uv 공식 바이너리 | [development/homebrew.md](development/homebrew.md) |
| macos | 키보드, 다크 모드, Dock, 트랙패드 세 손가락 드래그, 검정 배경화면, 화면 보호기 끄기 | [macos/system-settings.md](macos/system-settings.md) |
| power | 노트북: 충전 중 잠자기 안 함. 데스크톱: 늘 켜두기(화면은 10분 뒤 끔), 정전 후 자동 켜기, 원격 접속 확인 | [macos/system-settings.md](macos/system-settings.md) |
| dotfiles | `home/`의 설정 파일을 `~`에 연결 | 아래 "설정 파일" |
| runtimes | Node(fnm) 기본 버전, pnpm, Vercel CLI | [development/node.md](development/node.md) |
| agents | Claude Code, Codex CLI 설치 (공식 스크립트) | [agents/](agents/README.md) |
| browser | Browser Use CLI(uv)와 공식 스킬, 에이전트 전용 Chrome 자동 시작 | [agents/browser.md](agents/browser.md) |
| paseo | 사용자 스킬 연결, Paseo 데몬 첫 설정(앱 없이), 없는 프로필 추가, Paseo 도구 켜기, 데스크톱은 로그인 시 데몬 시작 | [agents/paseo.md](agents/paseo.md) |
| auth | GitHub 로그인, 데스크톱 자동 로그인, 남은 로그인 안내와 로그인할 앱 열기 | [development/git.md](development/git.md) |

## 자주 쓰는 명령

```sh
./bootstrap.sh --only dotfiles     # 한 단계만
./bootstrap.sh doctor              # 세팅 상태 검증
./bootstrap.sh snapshot            # 이 Mac에는 있는데 저장소에 없는 것 찾기
./bootstrap.sh --list              # 단계 목록
```

새 도구를 설치했으면 `snapshot`으로 확인하고 Brewfile에 옮겨 적는다. 그래야 다음 기기에도 깔린다.

## 새 기기 없이 시험하기

설정 병합·파일 보존·실패 판정은 `node --test scripts/*.test.mjs`로 검사한다. 테스트는 임시 경로와 외부 명령 대역을 사용하며 실제 홈·브라우저·인증을 바꾸지 않는다. 새 Mac의 전체 설치나 실제 브라우저 연결은 별도 검증이다.

전체 설치 검증에는 별도 Mac이나 macOS 가상 머신을 사용한다. `HOME`만 임시 경로로 바꾸는 방식은 외부 설치 프로그램의 시스템 변경까지 격리하지 못한다.

`doctor`의 Brewfile 검사는 Homebrew 등록 상태도 확인한다. `/Applications`에 직접 설치한 앱이 있어도 Homebrew에 등록되지 않았다면 불일치로 표시한다. 기존 앱의 재설치·관리 방식 변경은 별도로 처리한다.

## 설정 파일

- `home/<묶음>/`은 `~`과 같은 구조다. 파일 단위로 심볼릭 링크하므로 `~/.zshrc`를 고치면 바로 저장소에 반영된다 (`git diff`로 보임).
- `.seed`로 끝나는 파일은 대상이 없을 때만 복사한다. 도구가 스스로 고쳐 쓰는 파일(Codex `config.toml`)용.
- 같은 내용을 두 도구가 쓰는 파일은 저장소 안에서 링크한다. Codex `AGENTS.md`는 Claude Code `CLAUDE.md`를 가리킨다.
- Paseo 프로필은 `paseo` 단계에서 별도로 병합한다. 앱을 처음 실행한 뒤 `./bootstrap.sh --only paseo`를 실행한다. 기존 프로필 갱신은 [Paseo 문서](agents/paseo.md#설치와-갱신) 참고.
- 직접 만든 스킬은 `agents/skills/`에서 관리한다. `paseo` 단계가 Claude(`~/.claude/skills`)·Codex(`~/.agents/skills`) 검색 경로에 같은 원본을 연결한다. 도구가 관리하는 기본 스킬과 구분해 `yw-` 접두사를 사용한다. 같은 이름의 다른 스킬이 있으면 덮어쓰지 않고 멈춘다.
- 기존 파일은 `~/.local/state/bootstrap/backup/<시각>-<번호>/`로 옮긴 뒤 연결한다. 되돌리려면 링크(`~/.zshrc` 등)를 지우고 백업 폴더의 파일을 제자리로 옮긴다.
- 기기마다 다른 설정은 `~/.zshrc.local`, `~/.gitconfig.local`에 둔다. 저장소에 넣지 않는다.
- API 키 같은 비밀값은 `~/.zsh_secrets`에 `export`로 두고 권한은 600으로 한다. `.zshrc`가 있으면 읽는다. 저장소에는 넣지 않고, 커밋 전에 gitleaks가 한 번 더 검사한다.
- 넣지 않는 것: 인증 파일(`auth.json`, gh `hosts.yml`), SSH 개인키, 각 도구의 세션·캐시·기록, 도구가 설치해 주는 스킬·플러그인(그 도구가 관리한다).

## 구조

```text
install.sh            새 Mac 한 줄 설치 (저장소 받기 → bootstrap.sh)
bootstrap.sh          진입점
Brewfile              설치 목록
TOOLS.md              도구별 공식 문서 링크, 설치 방법을 고른 이유
home/                 ~에 연결할 설정 파일 (묶음별)
scripts/steps/        단계별 스크립트
scripts/*.mjs         설정 병합·스킬 배치 (같은 이름의 *.test.mjs가 테스트)
scripts/doctor.sh     검증
scripts/snapshot.sh   저장소에 빠진 것 찾기
macos/                첫 부팅, 시스템 설정
development/          Homebrew, Node, git, 터미널, 컨테이너
agents/               코딩 에이전트별 설치·설정, 브라우저·GUI 작업
agents/skills/        직접 만든 스킬 (yw-*)
.githooks/            커밋 전 비밀값 검사
```
