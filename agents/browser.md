# 브라우저 작업

웹 UI 검증과 기존 Chrome 로그인·탭 작업은 **uv로 설치한 Browser Use CLI(`browser-use`)**를 사용한다. 먼저 설치된 공식 `browser-use` 스킬을 읽고, 이 문서의 운영 규칙을 함께 따른다. 이 문서가 스킬의 일반 지침보다 우선한다. 공개 정보의 단순 HTTP fetch에는 브라우저가 필요 없다. 다른 도구가 필요하면 이유를 알리고 사용자와 선택을 조율한다.

기존 Chrome의 인증 프로필을 쓰고 같은 연결을 여러 작업이 순서대로 재사용해야 해서 Browser Use를 골랐다(2026-10, agent-browser·Aside·Paseo Browser와 비교). ChatGPT Browser 플러그인과 이름이 같을 수 있으니 구분한다. 네이티브 앱의 GUI 조작은 [Computer Use](computer-use.md)를 따른다.

## 설치와 확인

```sh
./bootstrap.sh --only browser            # Chrome이 종료된 상태에서
node scripts/browser-use-setup.mjs --check
node scripts/browser-settings.mjs --check
```

- `browser` 단계는 Browser Use가 없을 때만 `uv tool install --python 3.12 browser-use`로 설치한다. 기존 CLI는 갱신하지 않는다. ([공식 CLI](https://docs.browser-use.com/open-source/browser-use-cli))
- 공식 스킬(`browser-use skill` 출력)을 Codex용 `~/.agents/skills/browser-use`와 Claude용 `~/.claude/skills/browser-use`에 둔다. 다른 내용의 같은 이름 스킬이 있으면 덮어쓰지 않고 중단한다. Codex 이전 경로 `~/.codex/skills/browser-use`가 있으면 중복으로 보이므로 중단한다. 내용을 확인하고 지우거나 `~/.agents/skills`로 옮긴다.
- Chrome이 종료되어 있으면 `Local State`의 `devtools.remote_debugging.user-enabled`만 백업 후 병합한다. 실행 중이면 수정하지 않고 수동 작업 대기(종료 코드 2)로 알린다. 이 설정이 연결 승인을 없애지는 않는다. **연결할 때 Chrome이 띄우는 Allow는 사용자가 직접 승인한다.** 공개된 설정 CLI가 아니므로 Chrome 업데이트 후 연결을 확인한다.
- 설치·doctor 검사는 브라우저 연결이나 사이트 로그인을 확인하지 않는다.

갱신: `uv tool upgrade browser-use` 후 `browser-use skill` 내용이 바뀌면 doctor가 스킬 불일치를 알린다. 두 스킬 폴더를 지우고 `./bootstrap.sh --only browser`로 다시 배치한다.

Chrome 설정 백업은 `${XDG_STATE_HOME:-$HOME/.local/state}/bootstrap/backup/browser-chrome-*`에 있고 `source-path.txt`에 원본 위치가 적혀 있다. Chrome을 종료한 뒤 복원한다.

### 이전 구성을 쓰던 기기

예전 bootstrap은 agent-browser와 그 스킬을 설치하고 Paseo Browser(`daemon.browserTools.enabled`)를 켰다. 지금은 설치·검사하지 않는다. 그런 기기에서는 다음을 정리한다.

- `brew uninstall agent-browser`, 스킬 폴더 `~/.agents/skills/agent-browser`와 `~/.claude/skills/agent-browser` 삭제
- Paseo Browser가 필요 없으면 Paseo 설정에서 끈다

## 운영 규칙

### 연결 재사용

- 로컬 작업은 **default daemon(`BU_NAME` 생략)**과 같은 runtime 환경(`BH_HOME`·socket 경로·확인된 CDP 설정)을 작업 묶음 동안 유지한다. 작업이나 에이전트마다 새 daemon·임시 runtime을 만들지 않는다.
- 이미 연결된 daemon은 다음처럼 기존 연결만 허용해 재사용한다. 이 옵션은 IPC와 실제 CDP 응답을 확인하고, 실패하면 자동 시작·재연결 없이 중단한다.

  ```sh
  BH_REQUIRE_EXISTING_DAEMON=1 browser-use <<'PY'
  print(page_info())
  PY
  ```

- 공유 daemon은 작업이 끝날 때마다 종료하지 않는다. endpoint·PID·target·임시 runtime은 전역 설정에 고정하지 않는다.

### 탭 소유와 조작 순서

- daemon 하나는 current target을 공유하므로 **다른 탭이라도 조작은 순서대로** 한다. Supervisor나 담당자가 소유자·own target·조작 차례를 정한다.
- 작업자는 `current_tab()`/`list_tabs()`로 자기 target을 확인하고 `switch_tab()`으로 선택한다. 작업 탭은 필요할 때 `new_tab()`으로 한 번 만들어 재사용한다.
- 사용자 탭은 탐색·이동·닫기·자동 전면 전환하지 않는다. 끝나면 불필요한 own 탭만 닫는다.
- 공유 프로필의 로그인·로그아웃은 조율한다.

### 실패와 새 연결

- 닫힌 own 탭, 살아 있는 daemon의 CDP 연결 끊김, daemon 종료를 구분한다. PID·socket 존재나 IPC 응답만으로 연결이 건강하다고 보지 않는다.
- timeout은 취소의 증거가 아니다. 결과를 모르는 명령이나 승인 대기 중인 요청을 다시 실행하지 않는다. 자동 재연결을 반복하지 않는다.
- 새 연결이 필요하면 담당자가 현재 Chrome 프로세스와 확인된 `BU_CDP_URL`/`BU_CDP_WS`, 새 Allow에 대한 사용자 대응을 한 번 조율한다. 자동 발견이 성공한다고 가정하지 않는다.
- 사용자 Chrome을 강제 종료·재실행하지 않고, 지정된 인증 환경을 cloud·복사 프로필·임시 브라우저로 대체하지 않는다.
- 공식 스킬의 `mac-approve` 자동 클릭·접근성 권한 추가·보안 완화는 쓰지 않는다. 연결하지 못하면 이유와 확인하지 못한 항목을 보고한다.

### Chrome 프로필 선택과 확인

**로그인 상태가 필요한 작업 또는 사용자가 Chrome 프로필을 지정한 작업**에 적용한다. 공개 페이지·localhost의 일반 UI 검증에는 필요 없다.

- 우선순위는 **이번 작업에 명시한 프로필 → 기기별 기본값**이다. 둘 다 없으면 확인한다. 현재 연결이나 Chrome의 최근 사용 기록을 기본값으로 삼지 않는다.
- 기본값은 `${XDG_CONFIG_HOME:-$HOME/.config}/bootstrap/browser-profile.json`에 둔다. 필수 문자열은 `user_data_dir`(Chrome 사용자 데이터 폴더의 절대 경로), `profile_directory`(그 아래 프로필 폴더 이름), 선택 값은 `display_name`이다. 표시명은 바뀔 수 있으므로 경로로 식별한다.
- "이 프로필을 기본으로 해줘"처럼 명시적으로 요청받았을 때만 경로를 확인하고 파일을 저장한다. "이번에는 이 프로필로"는 이번 작업에만 적용한다. 모호하면 영구 변경으로 해석하지 않는다.
- 파일이 없거나 읽기·경로 확인에 실패하면 추측하지 않고 보고한다. bootstrap은 이 파일을 만들거나 검사하지 않는다. 인증 정보·endpoint·PID·target은 넣지 않는다.
- 이 파일은 에이전트가 읽는 선호이며 Browser Use가 자동 적용하는 설정이 아니다. 기본값 저장이 Chrome 전환을 실행하지도 않는다.

확인과 전환:

1. Chrome `Local State`의 프로필 목록은 후보 이름·폴더 확인에만 쓴다. `last_used`나 탭 목록은 작업 탭의 프로필 증거가 아니다.
2. 새 own 탭에서 `chrome://version/`의 프로필 경로를 읽어 선택한 `user_data_dir/profile_directory`와 대조한 뒤, **같은 탭**에서 작업 URL로 이동한다. 다른 탭에서 읽은 값으로 기존 탭의 프로필을 추정하지 않는다.
3. 일치하지 않거나 확인할 수 없으면 그 프로필에 의존하는 작업을 멈추고 보고한다. 사용자와 실제 전환을 조율한 뒤 다시 대조한다. 창 선택이나 프로필 이름 지정만으로 연결 대상이 바뀌었다고 보지 않는다.
4. 프로필 일치는 사이트 로그인 유효성의 증거가 아니다. 비밀번호·MFA·동의가 필요하면 사용자에게 넘긴다.
