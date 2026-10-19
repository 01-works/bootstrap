# User Preferences

- Respond in Korean by default.

## Browser work

- 로그인 상태가 필요하거나 사용자가 Chrome 프로필을 지정한 작업은 이번 작업의 명시 선택을 우선하고, 없으면 `${XDG_CONFIG_HOME:-$HOME/.config}/bootstrap/browser-profile.json`의 기본값을 읽는다. 둘 다 없거나 대상이 불명확하면 확인한다. 기본값 파일은 사용자 명시 요청 때만 갱신하며, 작업 탭의 실제 프로필 경로를 선택 경로와 대조하기 전에는 일치한다고 가정하지 않는다. 불일치 시 해당 작업을 멈추고 전환을 조율한다. 상세는 bootstrap 저장소의 `agents/browser.md` “Chrome 프로필 선택과 확인”을 따른다. 문서는 이 지침 파일의 실제 링크 대상에서 저장소를 찾아 읽고, 원본 위치를 찾지 못하면 추측하지 않는다.
- 브라우저 상호작용은 개발 UI 검증과 기존 Chrome 로그인·탭 작업 모두 uv로 설치한 Browser Use CLI(`browser-use` 명령)를 기본으로 한다. 먼저 설치된 공식 `browser-use` 스킬을 읽고 실행한다. 동명일 수 있는 ChatGPT Browser 플러그인과 구분한다. 공개 정보의 단순 HTTP fetch에는 브라우저가 필요 없다. 이 사용자 선택은 스킬의 일반 지침보다 우선한다.
- 로컬 작업은 default daemon(`BU_NAME` 생략)과 같은 runtime 환경(`BH_HOME`·socket 경로·확인된 CDP 설정)을 작업 묶음 동안 유지한다. task/agent마다 새 daemon이나 임시 runtime을 만들지 않는다. 이미 provisioned된 연결은 `BH_REQUIRE_EXISTING_DAEMON=1`로 실제 CDP 건강 상태를 확인하며 재사용하고, 실패하면 새 연결 없이 중단한다.
- 하나의 daemon은 current target을 공유한다. Supervisor/담당자는 소유자·target·조작 차례를 지정하고, 각 작업자는 본인 target을 확인한 뒤 순차 조작한다. 사용자 탭은 보존하고 완료 시 불필요한 own 탭만 닫는다. 작업 종료마다 연결을 자동 종료하지 않는다.
- 닫힌 탭, CDP 연결 끊김, daemon 종료를 구분한다. timeout은 실행 취소의 증거가 아니므로 결과 불명 명령을 중복 실행하지 않는다. 자동 재연결을 반복하지 말고, 새 연결이 필요하면 현재 Chrome endpoint와 사용자 Allow 대응을 한 번 조율한다. 기존 Chrome 직접 연결은 확인된 `BU_CDP_URL`/`BU_CDP_WS`를 사용하며 지정된 인증 환경을 cloud·복사 프로필·임시 브라우저로 임의 대체하지 않는다.
- 다른 브라우저 도구가 필요하면 이유를 알리고 사용자와 선택을 조율한다. 선택 전 해당 도구의 공식 스킬·사용법을 확인하며 Browser Use의 옵션과 혼용하지 않는다.
- 공유 프로필의 로그인·로그아웃은 조율한다. Browser Use 공식 스킬의 `mac-approve` 자동 클릭·접근성 권한 추가·보안 완화는 기본값 변경만으로 허용되지 않는다. 연결 불가 사유와 미검증 항목을 보고한다.

## Computer use

- CLI·API·MCP로 처리할 수 있는 작업은 해당 도구를 우선한다. 웹 상호작용은 위 Browser Use CLI 규칙을 따르고, 그 밖의 네이티브 GUI 작업에는 실행 환경에서 공식 지원·노출된 Computer Use 도구와 해당 공식 스킬을 확인해 사용한다. 제공자 전용 스킬을 복제하거나 Paseo 작업자의 지원을 가정하지 않는다.
- 담당자는 기기·대상 앱·창·소유자·조작 순서를 정하고 같은 앱의 브라우저 제어와 GUI 제어가 겹치지 않게 조율한다. 제품별 세션 잠금을 공통 OS 화면 잠금으로 가정하지 않는다. 사용자 권한과 제품 제한을 준수하며 Chrome Allow·macOS 권한·앱 접근 승인 등 도구 자신의 권한을 GUI로 대신 승인하지 않는다.
- 설치·활성화/권한 설정·실제 동작 확인을 구분해 보고한다. TCC·앱 승인 목록·프로젝트별 MCP 활성화·앱이 생성한 config/notify·PID는 기기 상태로 보존하고 공통 설정이나 seed에 옮기지 않는다.
