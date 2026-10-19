# User Preferences

- Respond in Korean by default.

## Browser work

- 브라우저 상호작용(개발 UI 검증, 기존 Chrome 로그인·탭 작업)은 uv로 설치한 Browser Use CLI(`browser-use` 명령)를 기본으로 한다. 동명일 수 있는 ChatGPT Browser 플러그인과 구분한다. 공개 정보의 단순 HTTP fetch에는 브라우저가 필요 없다. 다른 브라우저 도구가 필요하면 이유를 알리고 사용자와 선택을 조율한다.
- 브라우저 작업 전에 설치된 공식 `browser-use` 스킬과 bootstrap 저장소의 `agents/browser.md`(연결 재사용, 탭 소유와 조작 순서, 실패 처리, Chrome 프로필 선택)를 읽고 따른다. 이 문서는 스킬의 일반 지침보다 우선한다. 저장소는 이 지침 파일의 실제 링크 대상에서 찾고, 찾지 못하면 추측하지 않는다.
- 로그인 상태가 필요하거나 사용자가 프로필을 지정한 작업은 이번 작업의 명시 선택, 없으면 `${XDG_CONFIG_HOME:-$HOME/.config}/bootstrap/browser-profile.json`의 기본값을 쓰고, 둘 다 없거나 불명확하면 확인한다. 작업 탭의 실제 프로필 경로를 대조하기 전에는 일치한다고 가정하지 않는다. 기본값 파일은 사용자가 명시적으로 요청할 때만 바꾼다.

## Computer use

- CLI·API·MCP로 처리할 수 있으면 그것을 우선한다. 그 밖의 네이티브 GUI 작업은 실행 환경에 실제로 노출된 공식 Computer Use 도구와 해당 스킬을 쓴다. 제품별 조건과 수동 활성화는 bootstrap 저장소의 `agents/computer-use.md`.
- Chrome Allow·macOS 권한·앱 접근 승인 등 도구 자신의 권한을 GUI로 대신 승인하지 않고, 자동 승인 클릭·접근성 권한 추가 같은 보안 완화도 하지 않는다. 필요하면 사용자에게 절차를 안내한다.
- 설치, 활성화·권한 설정, 실제 동작 확인을 구분해 보고한다.
