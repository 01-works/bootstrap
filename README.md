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
- 자동 시작: 데스크톱은 로그인할 때 Paseo 데몬과 에이전트 Chrome을 띄우고, Paseo 새 버전을 한 시간마다 확인해 올린다(앱이 꺼져 있어 앱이 올리지 못함). 노트북은 필요할 때 시작하고 Paseo는 앱이 올린다.
- 재시동 복구: 데스크톱은 FileVault를 끄고 자동 로그인을 켜서 정전 뒤에도 혼자 켜지고 로그인한다. 노트북은 FileVault를 켠다.
- 로그인하는 계정 (GitHub, Google, Claude, Codex): 기기마다 로그인한다.
- git 커밋 작성자: 다른 GitHub 계정을 쓰는 기기는 `~/.gitconfig.local`에 이름·이메일을 적는다.

예외로, 일부 기기에만 필요한 설정은 사람이 켜는 기기 역할로 둔다. 켠 역할은 기기에 남고 저장소에는 기기 목록을 두지 않는다 (아래 "기기 역할").

## 단계

`scripts/steps/`의 번호 순서대로 실행된다. 여러 번 실행해도 이미 된 것은 건너뛴다.

preflight, xcode, Homebrew 자체 설치가 실패하면 멈춘다. Brewfile 일부 항목 실패와 나머지 단계 실패는 모아 두고 다음 단계로 진행한다. 마지막에 실패한 단계와 재실행 명령을 보여 주며 최종 doctor 실패도 종료 코드에 반영한다.

종료 코드 `0`은 완료, `1`은 실패, `2`는 수동 작업 대기다. 예를 들어 데스크톱의 화면 공유가 꺼져 있거나 FileVault가 켜져 있으면 대기로 표시한다. 실패와 대기가 함께 있으면 `1`을 반환한다. 전체 실행에서는 수동 작업을 마친 뒤 최종 doctor까지 통과해야 완료다.

| 단계 | 하는 일 | 문서 |
|---|---|---|
| preflight | Apple Silicon/Intel·네트워크 확인 | |
| xcode | Xcode 명령줄 도구(git 포함), 이 저장소의 커밋 전 검사 켜기 | |
| homebrew | Homebrew 설치, Brewfile 설치, Intel용 uv 공식 바이너리 | [development/homebrew.md](development/homebrew.md) |
| macos | 키보드, 다크 모드, Dock(크기·고정 항목), 트랙패드 세 손가락 드래그, 검정 배경화면, 화면 보호기 끄기 | [macos/system-settings.md](macos/system-settings.md) |
| power | 노트북: 충전 중 잠자기 안 함. 데스크톱: 늘 켜두기(화면은 10분 뒤 끔), 정전 후 자동 켜기, 원격 접속 확인 | [macos/system-settings.md](macos/system-settings.md) |
| dotfiles | `home/`의 설정 파일을 `~`에 연결 | 아래 "설정 파일" |
| runtimes | Node(fnm) 기본 버전, pnpm, Vercel CLI | [development/node.md](development/node.md) |
| agents | Claude Code, Codex CLI 설치 (공식 스크립트) | [agents/](agents/README.md) |
| browser | Browser Use CLI(uv)와 공식 스킬, 에이전트 전용 Chrome 자동 시작 | [agents/browser.md](agents/browser.md) |
| paseo | 사용자 스킬 연결, Paseo 데몬 첫 설정(앱 없이), 없는 프로필 추가, Paseo 도구 켜기, 기본 플러그인 설치·버전 맞춤, 데스크톱은 로그인 시 데몬 시작과 Paseo 새 버전 올리기 | [agents/paseo.md](agents/paseo.md) |
| heavy | 공용 heavy 대기열 도구 `yw-heavy`를 `~/.local/bin`에 설치 (모든 기기) | [agents/heavy-queue.md](agents/heavy-queue.md) |
| ghapp | 에이전트 GitHub 신원 도구 `yw-gh`를 `~/.local/bin/gh`로 설치. App 설정도 기기 단위 끄기 파일도 없으면 수동 작업 대기 | [agents/github-app.md](agents/github-app.md) |
| auth | GitHub 로그인, 데스크톱 자동 로그인, 남은 로그인 안내와 로그인할 앱 열기 | [development/git.md](development/git.md) |
| autoupdate | 저장소 자동 갱신 등록 (로그인할 때와 10분마다) | 아래 "변경 전파" |
| roles | 이 기기에 켠 역할만 저장된 값으로 다시 맞춤. 켠 역할이 없으면 아무것도 안 함 | 아래 "기기 역할" |

## 자주 쓰는 명령

```sh
./bootstrap.sh --only dotfiles     # 한 단계만
./bootstrap.sh update              # 저장소를 받아 바뀐 부분만 적용 (수동 작업 대기 처리)
./bootstrap.sh paseo-upgrade       # (데스크톱) Paseo를 정식 최신 버전으로. 실행 중 에이전트가 있으면 --force
./bootstrap.sh doctor              # 세팅 상태 검증
./bootstrap.sh role status         # 기기 역할 상태 (켜기·끄기: role add|remove verifier)
./bootstrap.sh snapshot            # 이 Mac에는 있는데 저장소에 없는 것 찾기
./bootstrap.sh --list              # 단계 목록
```

새 도구를 설치했으면 `snapshot`으로 확인하고 Brewfile에 옮겨 적는다. 그래야 다음 기기에도 깔린다.

## 변경 전파

아무 기기에서나 고쳐서 push하면 다른 기기가 따라온다. `autoupdate` 단계가 등록한 LaunchAgent(`local.bootstrap.update`)가 로그인할 때와 10분마다 `./bootstrap.sh update --auto`를 실행한다. 잠들어 있던 기기는 깨어난 뒤 따라온다. 공개 저장소라 받을 때 로그인이 필요 없다.

- 받기: fetch 후 fast-forward만 한다. 커밋 안 된 변경이 있거나 이 기기의 커밋과 갈라졌으면 받지 않고 "보류"로 알린다. push·merge는 하지 않는다. 고치는 중인 기기(커밋 안 된 변경만 있고 새 커밋 없음)는 건드리지 않는다.
- 적용: 이 기기에 마지막으로 적용한 커밋부터 바뀐 파일에 해당하는 단계만 실행한다. `home/` → dotfiles, `Brewfile` → homebrew(없는 것만 설치, 업그레이드 안 함), `agents/skills/` → paseo, `agents/paseo-profiles.json` → paseo와 기존 프로필 갱신, `agents/paseo-plugins.json` → paseo(플러그인 설치·버전 맞춤), `scripts/yw-heavy.sh` → heavy, `scripts/yw-gh.sh`·`scripts/yw-gh-app.mjs`·`scripts/yw-gh-lib.sh` → ghapp, `scripts/role.sh`·`scripts/verifier-logs.sh` → roles, `scripts/steps/<번호>-<이름>.sh` → 그 단계, `bootstrap.sh`·`scripts/lib.sh` → 전 단계. 문서·테스트만 바뀌면 실행하지 않는다. 적용 기록이 없으면 전 단계를 확인하고, 전체 설치가 실패 없이 끝나면 기록을 남긴다.
- 사람이 필요한 일: 자동 갱신은 관리자 비밀번호(전원 설정·자동 로그인·Homebrew 설치), 설치 창(Xcode 명령줄 도구), GitHub 로그인, 배경화면 제어 허용 창을 띄우지 않고 "수동 작업 대기"로 남긴다. 터미널에서 `./bootstrap.sh update`를 실행하면 대기 단계까지 다시 실행한다. 관리자 비밀번호가 필요한 cask는 자동 갱신에서 실패로 표시된다.
- 실패: 적용 기록을 남기지 않고 같은 커밋은 한 시간 뒤 다시 시도한다. 새 커밋이 오면 바로 시도한다.
- 알림: 결과가 바뀔 때 한 번 macOS 알림을 띄운다. 새 터미널은 실패·대기·보류이거나 하루 넘게 저장소를 확인하지 못했을 때 한 줄 보여 주고, `doctor`도 같은 상태를 검사한다. 기록은 `~/.local/state/bootstrap/update/` (`update.log`, `status`, `applied`).
- 휴대폰 알림(선택): `~/.config/bootstrap/notify-url`에 주소 한 줄(예: [ntfy](https://docs.ntfy.sh/publish/)의 `https://ntfy.sh/<추측하기 어려운 주제>`)을 두면 실패·대기·보류를 보낸다. 기기 이름과 단계 이름이 그 서비스로 나간다. 주제는 아는 사람 누구나 구독할 수 있으므로 비밀값처럼 다루고(권한 600) 저장소에 넣지 않는다.
- 주의: `main`에 push한 내용은 모든 기기에서 사용자 권한으로 자동 실행된다. 관리자 권한은 쓰지 않는다.
- 끄기: `launchctl bootout gui/$(id -u)/local.bootstrap.update` 후 `~/Library/LaunchAgents/local.bootstrap.update.plist`를 지운다.

## 기기 역할

모든 기기에 같은 것을 설치한 뒤, 일부 기기에만 필요한 설정을 역할로 켠다. 켜고 끄는 것은 사람이 하고, 켠 뒤에는 `roles` 단계가 저장된 값으로 다시 맞춘다(역할 코드가 바뀌면 자동 갱신이 전한다). 상태는 `~/.config/bootstrap/roles/<역할>`(권한 600)에 남는다. 역할은 특정 프로젝트를 알지 않는다.

### verifier

무거운 검증을 맡는 기기. 다른 기기가 결과 로그만 읽어 간다.

```sh
./bootstrap.sh role add verifier --ssh-key <공개키 파일>   # 처음 한 번. 로그를 읽을 기기의 공개키
./bootstrap.sh role add verifier --colima-memory 8        # 값 바꾸기 (키는 저장된 것을 씀)
./bootstrap.sh role status                                # 0 준비 완료, 2 수동 작업 대기, 1 실패·꺼짐
./bootstrap.sh role remove verifier                       # 끄기
```

켜면 하는 일 (여러 번 실행해도 같다):

- colima 메모리: `~/.colima/default/colima.yaml`의 `memory:`를 기본 6 GiB로 바꾼다(`--colima-memory`로 변경). 원래 값을 기록한다. 실행 중인 VM은 다시 시작하지 않으므로 다음 시작부터 적용된다. colima 설정이 아직 없으면 `colima start --memory 6`을 한 번 실행한 뒤 다시 켠다.
- 자동 시작 끄기: 에이전트 Chrome, Paseo 데몬, Paseo 업그레이드를 등록하지 않고 있으면 내린다. 이미 떠 있는 Paseo 데몬과 실행 중인 에이전트 Chrome은 끄지 않는다(이 명령을 Paseo 세션에서 실행할 수 있어서). Chrome은 끝내거나 다음 로그인부터 꺼진다.
- 로그 디렉터리: `~/.local/state/verifier/logs`(권한 700). 검증을 돌리는 쪽이 여기에 로그를 남긴다. 이 경로가 그쪽과의 약속이다.
- 읽기 전용 SSH: `~/.ssh/authorized_keys`에 `restrict,command="~/.local/bin/verifier-logs" … bootstrap-role-verifier` 한 줄을 넣는다. 이 키로 접속하면 어떤 명령을 보내도 `verifier-logs`만 실행되고, 로그 디렉터리의 파일을 `ls`, `tail [-n N] <파일>`, `cat <파일>`로만 읽는다. 같은 키가 제한 없는 다른 줄에 있으면 읽기 전용이 되지 않으므로 고치지 않고 실패한다.

  ```sh
  ssh <verifier 기기> ls
  ssh <verifier 기기> tail -n 200 <파일>
  ```

끄면 colima 값이 아직 verifier 값일 때만 원래대로 돌리고, 넣은 줄과 `verifier-logs`를 지우고, 자동 시작을 기기 종류에 맞게 다시 등록한다. 로그는 지우지 않는다(빈 디렉터리만 정리).

사용자 작업:

- macOS 원격 로그인 켜기: 시스템 설정 > 일반 > 공유 > 원격 로그인. 꺼져 있으면 `role status`가 수동 작업 대기(2)로 알린다.
- (선택) 이 기기에서 코딩 에이전트를 쓰지 않으면 Claude Code(`claude` 안에서 `/logout`)와 Codex(`codex logout`)에서 로그아웃한다.

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
scripts/update.sh     변경 전파 (./bootstrap.sh update)
scripts/paseo-upgrade.sh  데스크톱 Paseo 새 버전 올리기 (./bootstrap.sh paseo-upgrade)
scripts/yw-heavy.sh   공용 heavy 대기열 도구 (heavy 단계가 ~/.local/bin/yw-heavy로 설치)
scripts/yw-gh*        에이전트 GitHub 신원 도구 (ghapp 단계가 ~/.local/bin/gh로 설치)
scripts/role.sh       기기 역할 (./bootstrap.sh role, roles 단계)
scripts/verifier-logs.sh  verifier 기기의 읽기 전용 SSH 강제 명령
scripts/doctor.sh     검증
scripts/snapshot.sh   저장소에 빠진 것 찾기
macos/                첫 부팅, 시스템 설정
development/          Homebrew, Node, git, 터미널, 컨테이너
agents/               코딩 에이전트별 설치·설정, 브라우저·GUI 작업
agents/skills/        직접 만든 스킬 (yw-*)
.githooks/            커밋 전 비밀값 검사
```
