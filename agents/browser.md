# 브라우저 작업

웹 UI 검증과 기존 Chrome 로그인·탭 작업은 **uv로 설치한 Browser Use CLI(`browser-use`)**를 사용한다. 먼저 설치된 공식 `browser-use` 스킬을 읽는다. 공개 정보의 단순 HTTP fetch에는 브라우저가 필요 없다. 다른 도구가 필요하면 이유를 알리고 사용자와 선택을 조율한다.

동명인 ChatGPT Browser 플러그인과 구분한다. 네이티브 앱의 GUI 조작은 [Computer Use](computer-use.md)를 따른다. 과거 도구 비교는 [검증 기록](browser-validation.md)에만 남기며 작업 지침으로 사용하지 않는다.

## 설치와 확인

```sh
# 새 기기: Paseo 앱 초기 설정을 마치고 Chrome이 종료된 상태에서 실행
./bootstrap.sh --only browser,paseo
node scripts/browser-use-setup.mjs --check
node scripts/browser-settings.mjs --check
```

- Homebrew로 Chrome·uv를 준비한다. `browser` 단계는 Browser Use가 없을 때만 `uv tool install --python 3.12 browser-use`로 설치한다. [공식 CLI](https://docs.browser-use.com/open-source/browser-use-cli)
- 공식 스킬을 Codex·Claude의 기본/실제 설정 경로에 준비한다. 기존 CLI와 개인 스킬은 보존하고 충돌 시 중단한다. 제공자 전용 플러그인은 복제하지 않는다.
- Chrome 종료 상태에서 디버깅 설정만 백업 후 병합한다. 실행 중에는 수정하지 않으며, 운영 중 Chrome을 강제 종료하지 않는다. **연결 시 Chrome이 요구하는 Allow는 사용자가 직접 승인한다.**
- 설치·doctor 검사는 브라우저 연결이나 사이트 로그인을 확인하지 않는다. 동작 확인은 아래 운영 규칙에 따라 별도로 한다.

현재 설치 스크립트에는 이전 구성의 agent-browser 설치·스킬 검사와 Paseo Browser 활성화도 남아 있다. 이는 Browser Use의 사용 요건이나 대안 선택 지침이 아니다. 이번 문서 정리에서는 설치 동작·기존 앱을 변경하지 않았다. agent-browser 경로 충돌이 설치를 막으면 [기존 설치 정리](#기존-설치-정리)를 따른다.

## 설정 보존과 복구

Chrome은 `Local State`의 `devtools.remote_debugging.user-enabled`만 병합하며, 이 설정이 연결 승인을 없애지는 않는다. 공개된 안정적 설정 CLI가 아니므로 Chrome 업데이트 후 연결을 확인한다. Paseo의 기존 설정은 `daemon.mcp.injectIntoAgents`와 `daemon.browserTools.enabled`만 반영한다.

백업은 `${XDG_STATE_HOME:-$HOME/.local/state}/bootstrap/backup/` 아래 `browser-chrome-*`·`browser-paseo-*`에 저장하고 `source-path.txt`에 원본 위치를 기록한다. Chrome 복원은 종료 후 수행한다. Paseo는 이후 변경을 보존하도록 관련 키만 복원한다. CLI 저장 후 reload만 실패했다면 대상 home을 확인해 `paseo reload`한다.

`browser-settings.mjs`는 `--chrome`·`--paseo`로 대상을 지정할 수 있다. 종료 코드 `0`은 완료, `1`은 실패, `2`는 수동 작업 대기다. 인증·권한·프로필 원본은 저장소에 복사하지 않는다.

## Browser Use 기본 운영


로컬 작업은 **default daemon (`BU_NAME` 생략)**과 같은 runtime 환경을 작업 묶음 동안 유지한다. `BH_HOME`/`BROWSER_HARNESS_HOME`, socket 경로, 확인된 CDP 설정을 인계하고 task/agent마다 새 runtime·daemon을 만들지 않는다. 이미 건강하게 provisioned된 연결은 같은 환경에서 다음처럼 기존 연결만 허용한다.

```sh
# 담당자가 확인한 동일 runtime 환경에서 사용. 새 연결/발견은 허용하지 않는다.
BH_REQUIRE_EXISTING_DAEMON=1 browser-use <<'PY'
print(page_info())  # 조작 차례와 own target을 먼저 확인한 경우
PY
```

`BH_REQUIRE_EXISTING_DAEMON=1`은 설치본 0.1.13에서 IPC ping과 실제 `Target.getTargets`를 확인하고 실패 시 자동 시작·재연결 없이 중단하는 옵션이다. bootstrap용 복구 옵션이 아니다. daemon 하나는 mutable current target을 공유하므로 **다른 탭이라도 조작은 순차 진행**한다. Supervisor/담당자가 소유자·own target·조작 차례를 지정한다. 작업자는 `current_tab()`/`list_tabs()`로 소유 target을 확인하고 `switch_tab()`으로 선택한다. 새 작업 탭은 필요한 때 `new_tab()`으로 한 번 만들고 후속 CLI에서 재사용한다. 사용자 탭을 탐색·이동·닫지 않고 완료 시 불필요한 own 탭만 닫는다. 공유 daemon을 작업 종료마다 자동 종료하지 않는다.

닫힌 own 탭, daemon 종료, 살아 있는 daemon의 CDP 연결 끊김을 구분한다. PID/socket 존재나 IPC ping만으로 건강한 연결을 주장하지 않는다. healthy transport에서 target을 다시 선택하는 것과 새 browser WebSocket을 여는 것은 다르다. timeout/결과 불명 명령은 취소되었다고 가정하거나 중복 실행하지 않는다. 소유 환경의 상태·로그로 실패 층을 확인하고 자동 재연결을 반복하지 않는다.

새 연결이 필요하면 담당자가 **현재 Chrome 프로세스와 확인된 `BU_CDP_URL`/`BU_CDP_WS`**, 새 Allow에 대한 사용자 대응을 한 번 조율한다. 기본 local 발견은 이 Mac에서 실패한 이력이 있으므로 성공을 가정하지 않는다. 기존 승인형 Chrome만 대상으로 하는 작업은 Chrome 자동 실행/inspect 복구를 그대로 실행하지 말고 기존의 검토된 프로세스 실행 차단 조건을 유지한다. 실패 시 이유를 알리고 지정된 인증 환경을 cloud·프로필 복사·임시 브라우저로 대체하지 않는다. endpoint·PID·target·임시 runtime은 전역 설정에 고정하지 않는다.

공식 스킬의 `mac-approve` 자동 클릭·접근성 권한 추가·보안 완화는 이번 기본값 변경 범위에 포함되지 않는다. 승인 대기 중 원래 요청을 중복 실행하지 않는다. 탭을 자동 전면 전환하지 않고 공유 로그인·로그아웃은 조율한다. 재부팅·장기 유지·인증 지속성은 [검증 기록](browser-validation.md)의 확인 범위 이상으로 보장하지 않는다.

### Chrome 프로필 선택과 확인

이 절은 **로그인 상태가 필요한 작업 또는 사용자가 Chrome 프로필을 지정한 작업**에 적용한다. 공개 페이지·localhost의 일반 UI 검증에 프로필 대조를 일괄 요구하지 않는다. 브라우저 작업자가 적용하며, Supervisor 없이도 사용할 수 있다. Supervisor가 배정한다면 요청받은 프로필과 조작 차례를 기존 인계 항목으로 전달하면 충분하다.

#### 기본값과 이번 작업의 선택

- 우선순위는 **이번 작업에 명시한 Chrome 프로필 → 기기별 기본값**이다. 둘 다 없으면 사용할 프로필을 확인한다. 현재 연결이나 Chrome의 최근 사용 기록을 임의로 기본값으로 채택하지 않는다.
- 기본값은 `${XDG_CONFIG_HOME:-$HOME/.config}/bootstrap/browser-profile.json`에 둔다. 필수 문자열은 `user_data_dir`(실제 Chrome 사용자 데이터 폴더의 절대 경로), `profile_directory`(그 아래 프로필 폴더 이름)이며, `display_name`은 선택적인 표시명이다. 표시명은 중복·변경될 수 있으므로 경로로 식별한다.
- 에이전트는 “이 Chrome 프로필을 기본으로 지정/변경해줘”라는 명시 요청을 받았을 때 후보 경로를 확인하고 해당 파일을 저장한다. “이번에는 이 프로필로 해줘”는 이번 작업에만 적용하며 파일을 만들거나 갱신하지 않는다. 모호한 요청도 영구 변경으로 해석하지 않는다.
- 기본값 파일이 없거나 파싱·경로 확인에 실패하면 기본값을 추측하지 않는다. 이번 작업의 명시 선택이 있으면 그것을 확인해 사용하고, 없으면 누락·불일치를 보고해 선택을 확인한다. 기본값 저장 자체가 Chrome 전환을 실행하지는 않는다.
- bootstrap은 이 파일을 생성·seed·doctor 검사하지 않는다. 기기별 실제 경로·표시명과 로그인·쿠키·계정 정보는 저장소에 넣지 않으며, 이 선호 파일에도 인증 정보·endpoint·PID·target을 넣지 않는다. 필요한 서비스의 로그인은 기존 실제 Chrome 프로필에 유지하고 별도 자동화·복사 프로필로 대체하지 않는다.

#### 작업 대상 확인과 전환

1. 기존 runtime·조작 차례를 확인하고 위의 연결 재사용 규칙을 따른다. Chrome `Local State`의 프로필 목록은 후보 이름·폴더 확인에만 쓴다. `last_used`나 일반 탭 목록은 연결된 작업 탭의 프로필 증거가 아니다.
2. 새 own 작업 탭에서 먼저 `chrome://version/`의 프로필 경로(`profile_path`)를 읽고 선택한 `user_data_dir/profile_directory`의 실제 경로와 대조한 뒤, **같은 target**에서 작업 URL로 이동하는 절차를 권장한다. 별도 진단 탭에서 읽은 값은 그 탭만 증명한다. 사용자 기존 탭을 확인용으로 이동시키거나 새 탭의 결과·browserContextId로 기존 탭의 프로필을 추정하지 않는다.
3. 일치하지 않거나 확인할 수 없으면 해당 프로필에 의존하는 작업을 중단하고 이유를 보고한다. 사용자와 실제 프로필 전환을 조율한 뒤 다시 대조한다. 창 선택이나 프로필 이름 지정만으로 CDP 대상이 바뀌었다고 가정하지 않는다. 강제 종료·재실행·자동 전면 전환이나 복사·임시 프로필로 문제를 해결하지 않는다. 새 연결이 필요할 때만 endpoint와 수동 Allow를 한 번 조율한다.
4. 프로필 일치는 사이트 로그인 유효성의 증거가 아니다. 목적 사이트의 필요한 인증 상태는 별도로 확인하고 비밀번호·MFA·동의가 필요하면 사용자에게 인계한다. 확인용으로 만든 불필요한 own 탭만 정리하고 사용자 탭과 공유 연결은 유지한다.

**검증 범위:** 기존 연결에서 새 백그라운드 진단 탭의 프로필 경로 조회·탭 정리는 확인했다. 위의 같은 작업 target 대조 후 이동 절차 전체, 기존 사용자 탭의 프로필 판별, 실제 프로필 전환은 미검증이다. 설치된 CLI에 로컬 프로필 선택 기능이 있다고 가정하지 않으며, 기본값 파일은 에이전트가 읽는 운영 선호이지 Browser Use가 자동 적용하는 설정이 아니다.

## 기존 설치 정리

이 절은 현재 설치 단계의 과거 agent-browser 경로 검사를 통과하기 위한 유지보수 안내다. Homebrew 버전이 정상 실행되는지 확인한 뒤, PATH 앞에 있는 fnm/npm 설치가 문제일 때만 해당 Node 환경의 `npm uninstall -g agent-browser`로 중복 설치를 제거한다. 다른 설치나 개인 스킬은 자동 삭제하지 않는다. Browser Use는 uv 기반이므로 이 Node 전역 설치 이전과 무관하다.
