# 브라우저 작업

개발 화면·UI 흐름 검증은 **Paseo Browser**를 우선한다. 사용 중인 Chrome의 로그인·탭이 필요한 작업은 **agent-browser로 기존 Chrome에 직접 연결**한다. 이 기준은 Codex `AGENTS.md`, Claude `CLAUDE.md`, `yw-supervisor`의 작업 배정 지침에 함께 명시한다.

## 설치와 자동 설정

```sh
# Chrome을 정상 종료한 상태에서 실행
./bootstrap.sh --only browser,paseo
node scripts/browser-settings.mjs --check
```

`Brewfile`은 Google Chrome과 공식 Homebrew `agent-browser`를 설치한다. CLI 경로는 `/opt/homebrew/bin/agent-browser`로, fnm의 Node 버전을 바꿔도 유지된다. Homebrew가 필요한 런타임 의존성을 함께 관리하며 개발용 기본 Node는 fnm이 선택한다. `browser` 단계는 CLI 실행과 경로를 확인하고, 공식 설치기로 같은 스킬을 Codex·Claude 양쪽에 제공한다.

```sh
npx --yes skills add vercel-labs/agent-browser --global --agent codex claude-code --skill agent-browser --yes
```

공식 스킬 원본은 저장소에 복사하지 않는다. `~/.agents/skills/agent-browser`와 `~/.claude/skills/agent-browser`에 설치되며, 실제 사용법은 설치된 CLI의 `agent-browser skills get core`에서 읽는다. 공통 사용자 스킬도 양쪽에 연결하되 제공자 전용 내장 기능·플러그인은 임의로 복제하지 않는다. `agent-browser install`로 별도 테스트 브라우저를 다운로드하는 단계는 포함하지 않는다.

`scripts/browser-settings.mjs`가 다음 설정을 적용한다.

- **Chrome**: 종료 상태에서 `~/Library/Application Support/Google/Chrome/Local State`의 `devtools.remote_debugging.user-enabled`만 `true`로 병합한다. 기존 설정을 권한 600으로 백업하고 파일을 원자적으로 교체한다. 다음 Chrome 실행부터 적용된다. 실행 중이면 파일을 유지하고 재실행 방법을 안내한다.
- **Paseo**: 초기 설정이 존재할 때 CLI로 `daemon.mcp.injectIntoAgents`와 `daemon.browserTools.enabled`를 켜고 reload한다. 데몬을 재시작하지 않는다. 설정 파일이 없으면 Paseo 앱 초기 설정 후 같은 단계를 다시 실행한다.

백업은 `${XDG_STATE_HOME:-$HOME/.local/state}/bootstrap/backup/` 아래 `browser-chrome-*/Local State`, `browser-paseo-*/config.json`에 저장한다. 같은 폴더의 `source-path.txt`가 원래 경로를 기록한다. 이전 버전의 `browser-*/settings.json` 백업도 그대로 남는다. Chrome은 종료 후 원래 Local State 경로로 복원할 수 있다. Paseo는 관련 두 키를 원래 값으로 돌리는 편이 이후 다른 설정 변경을 보존한다.

Paseo CLI가 실패하면 일부 설정이 이미 저장되었을 수 있다. 저장 실패는 같은 설정 단계를 다시 실행하면 빠진 값만 적용한다. 저장은 됐지만 reload가 실패했다면 해당 home을 지정해 `paseo reload`를 실행한다. 설정값이 맞다는 것만으로 실행 중인 데몬의 반영까지 확인된 것은 아니다.

Chrome 설정 자동화는 [Chromium의 설정 키](https://github.com/chromium/chromium/blob/main/chrome/common/pref_names.h)와 [승인형 서버 구현](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/remote_debugging_server.cc)에 근거한다. 공개된 안정적 설정 CLI는 아니므로 Chrome 업데이트 후 실제 연결을 재검증한다. 이 설정은 Chrome 전체에 적용되며 연결마다 표시되는 사용자 허용 절차를 없애지 않는다. Chrome이 실행 중이면 `chrome://inspect/#remote-debugging`에서 직접 켜는 방법도 있다.

`--check`와 `doctor`는 설정값·설치 상태만 검사한다. 실제 Chrome 연결 승인이나 Paseo 데스크톱 연결까지 보장하지 않는다. `--chrome`, `--paseo`로 대상별 적용·검사도 가능하다. 종료 코드는 `0` 완료, `1` 실패, `2` 수동 작업 대기이며 한쪽 실패가 다른 쪽 설정 시도를 막지 않는다.

## 기존 npm 설치에서 이전

먼저 Homebrew 버전을 설치하고 `/opt/homebrew/bin/agent-browser --version`으로 동작을 확인한다. `command -v agent-browser`가 fnm 경로를 가리키면 해당 Node 버전의 `npm list -g agent-browser --depth=0`로 패키지를 확인한 뒤 `npm uninstall -g agent-browser`로 그 설치만 제거한다. 새 셸에서 경로가 `/opt/homebrew/bin/agent-browser`인지 확인한다. 다른 Node 버전에도 설치되어 있다면 그 버전에서도 같은 확인이 필요하다. bootstrap은 다른 경로의 기존 패키지를 임의로 삭제하지 않고 충돌을 알려 준다.

갱신은 Homebrew 또는 설치 방식을 인식하는 `agent-browser upgrade`로 수행한다. 기존 Chrome에 붙는 구성에서는 `agent-browser install`을 실행할 필요가 없다.

## 작업별 사용

Paseo Browser는 연결된 **데스크톱 앱**이 있어야 한다. 새 에이전트에서 Browser 도구를 사용하고, 자신이 만든 탭의 `browserId`만 조작한다. 로그인은 Paseo 브라우저 자체에 저장되며 기존 Chrome 로그인과 별도다. 브라우저를 실행하는 데스크톱과 개발 서버의 머신이 다르면 `localhost`도 다르므로 실제로 도달 가능한 개발 서버 주소가 필요하다.

Chrome은 작업별 세션과 탭을 분리한다.

```sh
agent-browser skills get core
agent-browser --session <작업별-고유-ID> --auto-connect --pin-tab tab new about:blank
```

자동 탐색이 실패하면 Chrome 설정 화면이나 해당 Chrome 프로세스의 리스닝 포트로 실제 주소를 확인한다. 승인 모드는 `/json/version`이 404여도 정상일 수 있다. **확인된 포트가 9222인 경우에만** 다음처럼 직접 연결한다.

```sh
agent-browser --session <작업별-고유-ID> --cdp ws://127.0.0.1:9222/devtools/browser --pin-tab tab new about:blank
```

허용 창을 사용자에게 알리고 승인 후 진행한다. 승인 대기 중 명령이 타임아웃되면 명령이 실행되었을 가능성이 있으므로 상태를 확인한 뒤 재시도한다. `--profile 이름`은 프로필 복사 방식이므로 기존 Chrome 직접 연결의 대체로 쓰지 않는다. 인증 작업이 막혀도 임시·테스트 브라우저로 자동 전환하지 않는다.

같은 탭의 병렬 조작을 피하고, 공유 프로필의 로그인·로그아웃은 다른 작업과 조율한다. Supervisor는 도구·주소·탭/세션 소유자를 지정한다. 완료 후 담당 탭만 닫고 미검증 항목을 보고한다.

## 실제 확인 (2026-10-18)

- Paseo 0.11.2: Browser 설정 적용·reload, 새 탭 생성, 페이지 탐색, 임시 폼 입력·클릭, 390px 너비 변경·스크린샷 확인. 임시 폼 기준 가로 넘침 없음. 실제 앱의 전체 기능·로그인 검증은 별도다.
- agent-browser 0.39.1 / Chrome 155.0.8059.80: 종료 상태에서 설정 병합·백업, Chrome 재실행, 사용자 승인 후 기본 데이터 디렉터리의 실행 중인 Chrome에 직접 연결 성공. 로컬 임시 폼 입력·클릭 결과와 저장 상태를 확인하고 검증용 데이터를 제거했다.
- 이 기기에서는 `DevToolsActivePort` 파일이 없어 `--auto-connect`가 실패했고, Chrome의 리스닝 포트를 확인한 뒤 위 WebSocket 주소로 연결했다.
- GitHub 확인 페이지는 로그인 화면으로 이동했다. 현재 연결된 프로필의 GitHub 로그인 유지·인증된 서비스 접근은 미검증이다. 로그인·로그아웃이나 인증 정보 복사는 하지 않았다.
- 리뷰 후 CLI를 같은 버전의 Homebrew 배포로 이전했다. 설정·세션 데이터는 유지하며, 설정 적용의 실패 경로는 임시 디렉터리 테스트로 검증한다.

근거: [Paseo Browser](https://paseo.sh/docs/browser.md), [agent-browser 설치](https://agent-browser.dev/installation), [CDP 직접 연결](https://agent-browser.dev/cdp-mode), [Chrome 승인형 연결](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect).
