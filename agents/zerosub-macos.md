# macOS에서 ZeroSub로 Antigravity 계정별 사용량 보기

Paseo의 **Accounts (ZeroSub) → Antigravity**에 Google 계정을 따로 로그인하고 각 계정의 5시간·주간 사용량을 확인한다. 공식 ZeroSub v1.35.0의 Linux용 계정 등록 기능을 macOS에서도 쓸 수 있게 한 선택 설치다. 현재 CLI 계정 하나만 확인하려면 터미널에서 `agy -p /usage`를 실행하면 된다.

이 패치는 계정 한도에 따른 전환이나 계정 간 대화 전송을 추가하지 않는다. Google은 개인 구독에서 제3자 앱이 CLI를 감싸 실행하는 방식과 계정 자동 전환을 지원하지 않는다고 안내하며, 직접 CLI로 스크립트를 실행하는 용도를 설명한다. [Google Antigravity FAQ](https://antigravity.google/docs/faq#can-i-use-antigravity-cli-headless-mode-in-third-party-coding-agents-or-automate-account-switching)

## 플러그인 준비

해당 Mac의 bootstrap 저장소 루트에서 실행한다. `agy --version`이 1.5 이상인지, Paseo의 **Settings → Plugins → Enable plugins**가 켜져 있는지 확인한다. 기존 설치의 소스와 활성 상태는 `paseo plugin ls zerosub`로 확인한다. 공식 버전이 v1.35.0보다 새로우면 그 버전이 macOS를 지원하는지 먼저 확인한다.

```sh
plugin_dir="$HOME/.local/share/bootstrap/zerosub-v1.35.0-macos"
patch_file="$PWD/agents/patches/zerosub-v1.35.0-macos.patch"
(
  set -e
  mkdir -p "$(dirname "$plugin_dir")"
  git clone --depth 1 --branch v1.35.0 https://github.com/kapybara-org/zerosub.git "$plugin_dir"
  cd "$plugin_dir"
  test "$(git rev-parse HEAD)" = 0a2abe28a93e288d4bf74726720ea723d1d24220
  git apply --check "$patch_file"
  git apply "$patch_file"
  npm ci --ignore-scripts --no-audit --no-fund
  npm run typecheck
)
```

준비에 성공한 뒤 설치한다. 같은 폴더를 이미 쓰는 Mac은 소스 커밋과 `git -C "$plugin_dir" apply --reverse --check "$patch_file"`로 패치 적용 여부를 확인한다. 다른 수정이 있는 폴더는 보존한다.

## 설치 및 기존 설정 보존

- ZeroSub가 처음이면 `paseo plugin install "$plugin_dir" --id zerosub`로 설치한다.
- 이미 이 패치 폴더에서 실행 중이면 `paseo plugin reload zerosub`로 다시 읽는다.
- 레지스트리 설치를 교체할 때는 해당 기기에서 사용 중인 ZeroSub 작업이 끝난 뒤 아래 절차를 실행한다. 제거하면 Paseo가 저장한 플러그인 설정이 삭제되므로 먼저 백업한다. 계정 목록과 로그인 홈은 별도 `zerosub/`에 있으므로 그대로 둔다. 꺼 둔 플러그인은 사용자가 활성화를 원할 때 교체한다.

```sh
(
  set -e
  umask 077
  test -f "$plugin_dir/paseo-plugin.json"
  test "$(git -C "$plugin_dir" rev-parse HEAD)" = 0a2abe28a93e288d4bf74726720ea723d1d24220
  git -C "$plugin_dir" apply --reverse --check "$patch_file"
  daemon_home="${PASEO_HOME:-$HOME/.paseo}"
  backup_dir=$(mktemp -d "$daemon_home/zerosub-before-macos.XXXXXXXX")
  printf '로컬 백업 %s\n' "$backup_dir"
  paseo plugin ls zerosub --home "$daemon_home" --json > "$backup_dir/installation.json"
  if [ -d "$daemon_home/plugin-settings/zerosub" ]; then
    cp -a "$daemon_home/plugin-settings/zerosub" "$backup_dir/settings"
  fi
  if [ -f "$daemon_home/zerosub/state.json" ]; then
    cp -p "$daemon_home/zerosub/state.json" "$backup_dir/state.json"
  fi
  paseo plugin remove zerosub --home "$daemon_home"
  if [ -d "$backup_dir/settings" ]; then
    mkdir -p "$daemon_home/plugin-settings/zerosub"
    cp -a "$backup_dir/settings/." "$daemon_home/plugin-settings/zerosub/"
  fi
  paseo plugin install "$plugin_dir" --id zerosub --home "$daemon_home"
)
```

`paseo plugin ls zerosub`에서 폴더 경로와 `running`을 확인하고 **Accounts**에서 기존 계정·설정을 확인한다. 설치에 실패하면 백업의 `installation.json`에서 원래 소스를 확인해 같은 ID로 다시 설치하고, 위와 같이 설정을 복원한 뒤 `paseo plugin reload zerosub`를 실행한다. 계정 목록이 사라진 경우에만 백업의 `state.json`과 비교한다. bootstrap의 정기 갱신은 폴더 설치를 유지한다.

## 계정 추가와 사용량 확인

1. 터미널의 `agy`에서 첫 Google 계정으로 로그인한다. 이 계정이 **CLI login**에 해당한다.
2. **Accounts (ZeroSub) → Antigravity → Add account**를 열고 두 번째 Google 계정으로 로그인한다. Google이 돌려준 코드는 그 Mac의 로그인 창에 붙여 넣는다. 추가한 계정은 별도 홈에 저장한다. macOS 데스크톱 로그인은 서로 같은 계정인지 ZeroSub가 식별할 수 없으므로 로그인할 때 계정을 확인한다.
3. **Accounts**의 새로고침 버튼을 누른다. 모델 그룹별로 제공되는 5시간·주간 항목을 확인한다. CLI의 `Remaining`은 잔여 비율이다. 예를 들어 CLI에서 100% 남음이면 ZeroSub 사용률은 0%다.
4. `Verify your account to continue`가 뜨면 Google이 그 계정에 추가 확인을 요구한 상태다. CLI 계정은 `agy -p /usage`를 실행한다. 추가한 계정은 ZeroSub 계정 목록(`$PASEO_HOME/zerosub/state.json`, 기본 `~/.paseo/zerosub/state.json`)의 해당 항목에 있는 `home`을 사용한다. 같은 Mac의 터미널에서 아래 명령의 경로를 바꾸어 실행한다. 표시된 링크를 해당 계정으로 열어 확인한 뒤 **Accounts**를 다시 새로고침한다.

```sh
env -u GEMINI_HOME -u GEMINI_API_KEY -u GOOGLE_API_KEY -u GOOGLE_APPLICATION_CREDENTIALS \
  -u AGY_ADC_AUTH -u GOOGLE_CLOUD_PROJECT -u GOOGLE_CLOUD_LOCATION \
  HOME="/추가한/계정의/home" SSH_CONNECTION=paseo agy -p /usage
```

로그인 코드·계정 확인 링크·계정 파일은 해당 Mac에서만 사용한다.
