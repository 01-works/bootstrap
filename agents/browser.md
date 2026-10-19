# 브라우저 작업

브라우저 작업은 **uv로 설치한 Browser Use CLI(`browser-use`)**를 사용한다. 먼저 설치된 공식 `browser-use` 스킬을 읽고, 이 문서의 운영 규칙을 함께 따른다. 이 문서가 스킬의 일반 지침보다 우선한다. 공개 정보의 단순 HTTP fetch에는 브라우저가 필요 없다. 다른 도구가 필요하면 이유를 알리고 사용자와 선택을 조율한다. ChatGPT Browser 플러그인과 이름이 같을 수 있으니 구분한다. 네이티브 앱의 GUI 조작은 [Computer Use](computer-use.md)를 따른다.

## 두 개의 Chrome

| | 에이전트 Chrome (기본) | 개인 Chrome (요청 시) |
|---|---|---|
| 앱 | Google Chrome Beta | Google Chrome |
| 프로필 | 전용 폴더 `${XDG_DATA_HOME:-~/.local/share}/bootstrap/agent-chrome` | 사용자의 기존 프로필 |
| 연결 | `http://127.0.0.1:9333`. 승인 창 없음 | 연결할 때마다 Chrome의 Allow를 사용자가 승인 |
| 로그인 | 에이전트가 쓸 서비스에 사용자가 한 번씩 로그인해 둔다 | 사용자의 평소 로그인 |
| 사용 | 모든 브라우저 작업의 기본 | **사용자가 명시적으로 요청한 경우만** |

에이전트 Chrome을 따로 둔 이유: 개인 Chrome은 연결할 때마다 사용자가 승인해야 해서 무인 작업에 맞지 않고, 에이전트가 개인 탭·로그인을 건드리지 않게 하기 위해서다. 앱을 Chrome Beta로 나눈 것은 같은 Chrome 앱으로 두 번째 인스턴스를 띄우면 Dock 아이콘·다른 앱의 링크가 에이전트 창으로 열릴 수 있어서다.

주의: 9333 포트는 승인 없이 열려 있으므로 이 Mac의 로컬 프로세스는 에이전트 Chrome을 조작할 수 있다. 에이전트 Chrome에는 작업에 필요한 계정만 로그인한다.

## 설치와 확인

```sh
./bootstrap.sh --only homebrew,browser
node scripts/browser-use-setup.mjs --check
node scripts/launch-agents.mjs --check --only agent-chrome --desktop   # 노트북은 --laptop
node scripts/browser-settings.mjs --check
```

- uv는 Apple Silicon에서는 Brewfile, Intel에서는 `homebrew` 단계의 공식 바이너리 설치기로 준비한다 (`~/.local/bin`, 기존 CLI·셸 설정 유지).
- Browser Use가 없을 때만 `uv tool install --python 3.12 browser-use`로 설치한다. 기존 CLI는 갱신하지 않는다. ([공식 CLI](https://docs.browser-use.com/open-source/browser-use-cli))
- 공식 스킬(`browser-use skill` 출력)을 Codex용 `~/.agents/skills/browser-use`와 Claude용 `~/.claude/skills/browser-use`에 둔다. 다른 내용의 같은 이름 스킬이 있으면 덮어쓰지 않고 중단한다. Codex 이전 경로 `~/.codex/skills/browser-use`가 있으면 중복으로 보이므로 중단한다. 내용을 확인하고 지우거나 `~/.agents/skills`로 옮긴다.
- **에이전트 Chrome**: LaunchAgent `local.bootstrap.agent-chrome`으로 등록한다. 늘 켜두는 기기(배터리 없음)는 로그인할 때 시작하고 비정상 종료 시 다시 띄운다. 노트북은 필요할 때 시작한다. 시작 명령은 `launchctl kickstart gui/$(id -u)/local.bootstrap.agent-chrome`. 자동 시작을 없애려면 `launchctl bootout gui/$(id -u)/local.bootstrap.agent-chrome` 후 `~/Library/LaunchAgents/local.bootstrap.agent-chrome.plist`를 지운다(doctor는 실패로 표시한다).
- **기본 연결**: Browser Use의 `.env`(`~/.config/browser-harness/agent-workspace/.env`)에 `BU_CDP_URL=http://127.0.0.1:9333`을 넣는다. 그래서 별도 설정 없이 실행하면 에이전트 Chrome에 연결된다. 같은 파일의 다른 값은 보존하고, 다른 `BU_CDP_URL`이 있으면 덮어쓰지 않는다.
- **개인 Chrome**: Chrome이 종료되어 있으면 `Local State`의 `devtools.remote_debugging.user-enabled`만 백업 후 병합한다. 실행 중이면 수정하지 않고 수동 작업 대기(종료 코드 2)로 알린다. 이 설정은 연결을 가능하게 할 뿐이고, 연결할 때마다 사용자가 Allow를 눌러야 한다.
- 설치·doctor 검사는 사이트 로그인을 확인하지 않는다.

갱신: `uv tool upgrade browser-use` 후 `browser-use skill` 내용이 바뀌면 doctor가 스킬 불일치를 알린다. 두 스킬 폴더를 지우고 `./bootstrap.sh --only browser`로 다시 배치한다.

개인 Chrome 설정 백업은 `${XDG_STATE_HOME:-$HOME/.local/state}/bootstrap/backup/browser-chrome-*`에 있고 `source-path.txt`에 원본 위치가 적혀 있다. Chrome을 종료한 뒤 복원한다.

### 이전 구성을 쓰던 기기

- 예전 bootstrap은 agent-browser와 그 스킬을 설치하고 Paseo Browser(`daemon.browserTools.enabled`)를 켰다. `brew uninstall agent-browser`, 스킬 폴더 `~/.agents/skills/agent-browser`와 `~/.claude/skills/agent-browser`를 지우고, Paseo Browser가 필요 없으면 Paseo 설정에서 끈다.
- 개인 Chrome에 붙어 있던 기본 daemon은 설정을 바꿔도 그대로 재사용된다. 그 daemon을 쓰던 작업이 끝난 뒤 `browser-use --reload`로 내리면 다음 실행부터 에이전트 Chrome에 연결된다.

## 운영 규칙

### 연결 재사용

- 에이전트 Chrome 작업은 **default daemon(`BU_NAME` 생략)**과 같은 runtime 환경(`BH_HOME`·socket 경로)을 작업 묶음 동안 유지한다. 작업이나 에이전트마다 새 daemon·임시 runtime을 만들지 않는다.
- 이미 연결된 daemon은 다음처럼 기존 연결만 허용해 재사용한다. 이 옵션은 IPC와 실제 CDP 응답을 확인하고, 실패하면 자동 시작·재연결 없이 중단한다.

  ```sh
  BH_REQUIRE_EXISTING_DAEMON=1 browser-use <<'PY'
  print(page_info())
  PY
  ```

- 에이전트 Chrome이 응답하지 않으면(`curl -fsS http://127.0.0.1:9333/json/version` 실패) 위의 `launchctl kickstart`를 한 번 실행하고 다시 확인한다.
- 공유 daemon은 작업이 끝날 때마다 종료하지 않는다. endpoint·PID·target·임시 runtime은 전역 설정에 고정하지 않는다.

### 탭 소유와 조작 순서

- daemon 하나는 current target을 공유하므로 **다른 탭이라도 조작은 순서대로** 한다. Supervisor나 담당자가 소유자·own target·조작 차례를 정한다.
- 작업자는 `current_tab()`/`list_tabs()`로 자기 target을 확인하고 `switch_tab()`으로 선택한다. 작업 탭은 필요할 때 `new_tab()`으로 한 번 만들어 재사용한다.
- 끝나면 불필요한 own 탭만 닫는다. 다른 작업의 탭은 건드리지 않는다.
- 에이전트 Chrome의 로그인·로그아웃은 공유 상태이므로 조율한다. 비밀번호·MFA·동의가 필요하면 사용자에게 넘긴다.

### 실패와 새 연결

- 닫힌 own 탭, 살아 있는 daemon의 CDP 연결 끊김, daemon 종료를 구분한다. PID·socket 존재나 IPC 응답만으로 연결이 건강하다고 보지 않는다.
- timeout은 취소의 증거가 아니다. 결과를 모르는 명령이나 승인 대기 중인 요청을 다시 실행하지 않는다. 자동 재연결을 반복하지 않는다.
- 연결하지 못하면 이유와 확인하지 못한 항목을 보고한다. cloud 브라우저나 임시 브라우저로 임의 대체하지 않는다.
- 공식 스킬의 `mac-approve` 자동 클릭·접근성 권한 추가·보안 완화는 쓰지 않는다.

## 개인 Chrome 사용 (요청 시)

사용자가 "내 Chrome으로", "로그인된 내 계정으로"처럼 **개인 Chrome 사용을 명시적으로 요청한 경우에만** 연결한다. 에이전트 Chrome에 로그인이 없다는 이유만으로 개인 Chrome으로 바꾸지 않는다. 그럴 때는 에이전트 Chrome에 로그인해 달라고 하거나 개인 Chrome 사용 여부를 묻는다.

- 에이전트 Chrome의 기본 연결과 섞이지 않게 이름 있는 daemon을 쓰고 `BU_CDP_URL`을 비운다.

  ```sh
  BU_CDP_URL= BU_NAME=personal browser-use <<'PY'
  print(page_info())
  PY
  ```

- 처음 연결할 때 Chrome이 Allow 창을 띄운다. 사용자에게 승인을 요청하고, 원래 명령을 다시 실행하지 말고 기다린다. 개인 Chrome을 강제 종료·재실행하지 않는다.
- 사용자 탭은 탐색·이동·닫기·자동 전면 전환하지 않는다. 확인용으로 만든 own 탭만 닫는다. 작업이 끝나면 사용자에게 연결을 유지할지 묻고, 필요 없으면 `BU_NAME=personal browser-use --reload`로 내린다.

### Chrome 프로필 선택과 확인

개인 Chrome에서 로그인 상태가 필요하거나 사용자가 프로필을 지정한 경우에 적용한다.

- 우선순위는 **이번 작업에 명시한 프로필 → 기기별 기본값**이다. 둘 다 없으면 확인한다. 현재 연결이나 Chrome의 최근 사용 기록을 기본값으로 삼지 않는다.
- 기본값은 `${XDG_CONFIG_HOME:-$HOME/.config}/bootstrap/browser-profile.json`에 둔다. 필수 문자열은 `user_data_dir`(Chrome 사용자 데이터 폴더의 절대 경로), `profile_directory`(그 아래 프로필 폴더 이름), 선택 값은 `display_name`이다. 표시명은 바뀔 수 있으므로 경로로 식별한다.
- "이 프로필을 기본으로 해줘"처럼 명시적으로 요청받았을 때만 경로를 확인하고 파일을 저장한다. "이번에는 이 프로필로"는 이번 작업에만 적용한다. 모호하면 영구 변경으로 해석하지 않는다.
- 파일이 없거나 읽기·경로 확인에 실패하면 추측하지 않고 보고한다. bootstrap은 이 파일을 만들거나 검사하지 않는다. 인증 정보·endpoint·PID·target은 넣지 않는다. 이 파일은 에이전트가 읽는 선호이며 Browser Use가 자동 적용하지 않는다.

확인과 전환:

1. Chrome `Local State`의 프로필 목록은 후보 이름·폴더 확인에만 쓴다. `last_used`나 탭 목록은 작업 탭의 프로필 증거가 아니다.
2. 새 own 탭에서 `chrome://version/`의 프로필 경로를 읽어 선택한 `user_data_dir/profile_directory`와 대조한 뒤, **같은 탭**에서 작업 URL로 이동한다. 다른 탭에서 읽은 값으로 기존 탭의 프로필을 추정하지 않는다.
3. 일치하지 않거나 확인할 수 없으면 그 프로필에 의존하는 작업을 멈추고 보고한다. 사용자와 실제 전환을 조율한 뒤 다시 대조한다. 창 선택이나 프로필 이름 지정만으로 연결 대상이 바뀌었다고 보지 않는다.
4. 프로필 일치는 사이트 로그인 유효성의 증거가 아니다. 비밀번호·MFA·동의가 필요하면 사용자에게 넘긴다.
