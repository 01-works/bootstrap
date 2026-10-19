# 기기 GUI 작업 (Computer Use)

CLI·API·MCP로 처리할 수 있으면 그것을 우선한다. 웹 UI와 기존 Chrome 작업은 [Browser Use](browser.md)를 쓴다. 그 밖의 네이티브 GUI는 아래 제품별 Computer Use를 쓴다.

앱·CLI 설치는 bootstrap이 하지만, Computer Use 활성화·OS 권한·앱 접근 승인은 기기마다 직접 한다. bootstrap·doctor 통과가 GUI 작업 준비 완료를 뜻하지 않는다.

## 제품과 실행 환경

공식 문서 기준 지원 조건이다(확인일 2026-10-19).

| 제품 / 실행 환경 | 경로와 조건 | macOS 권한·승인 대상 |
|---|---|---|
| Claude Code / 대화형 CLI | macOS, Pro/Max, claude.ai 인증. 내장 `computer-use` MCP를 프로젝트별로 활성화. `-p` 비대화형은 지원하지 않음 ([공식](https://code.claude.com/docs/en/computer-use)) | CLI를 실행하는 터미널 앱: 화면 기록·손쉬운 사용 |
| Claude 앱 / Cowork·데스크톱 Claude Code | 앱에서 Computer use 활성화, Pro/Max ([공식](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)) | Claude 앱이 요청하는 권한; 대상 앱 접근 승인은 별도 |
| ChatGPT 앱 / Work·Codex | 지원 지역에서 Computer Use 플러그인 활성화 ([공식](https://learn.chatgpt.com/docs/computer-use)) | `Codex Computer Use`: 화면 기록·손쉬운 사용; 앱 접근 승인은 별도 |
| Codex CLI / 터미널 | 공식 문서에 CLI 지원이 명시되어 있지 않음. 실제 노출된 도구로 확인 | 미확인 |
| Paseo 작업자 | 지원이 확인되지 않음. 기본으로 배정하지 않고, 도구가 없으면 위의 대화형 CLI·앱 경로를 안내 | 실행 경로 확인 전 가정하지 않음 |

## 수동 활성화

### Claude Code 대화형 CLI

1. `claude` 대화형 세션에서 `/mcp` → `computer-use` → Enable. 프로젝트별 상태다.
2. 사용자가 시스템 설정 > 개인정보 보호 및 보안에서 해당 **터미널 앱**의 화면 기록·손쉬운 사용 권한을 켠다. 화면 기록 반영에 재시작이 필요하면 진행 중인 세션 소유자와 조율한다.
3. 대상 앱 접근은 세션마다 사용자가 승인한다. 세션 잠금은 세션이 끝날 때까지 유지될 수 있으므로 소유자와 전환 순서를 정한다.

### Claude 앱

1. 앱 설정에서 Computer use를 켠다(현재 도움말: Settings → General → Enable computer use. 버전에 따라 메뉴가 다를 수 있다).
2. 사용자가 앱이 요청하는 OS 권한과 대상 앱 접근을 확인한다. CLI의 터미널 권한과는 별개다.

### ChatGPT Work·Codex 앱

1. ChatGPT 앱에서 Work 또는 Codex를 고르고 Plugins → Computer Use를 설치·활성화한다(server와 skill 토글).
2. 사용자가 `Codex Computer Use`의 화면 기록·손쉬운 사용 권한과 Settings → Computer use의 대상 앱 접근을 확인한다.
3. `@Computer` 또는 대상 앱을 명시해 요청한다. 제공자 전용 공식 스킬은 다른 제공자에 복제하지 않는다.

## 조작 순서와 권한

- 담당자가 기기·대상 앱/창·소유자·조작 순서를 정한다. 같은 앱을 브라우저 도구와 GUI 도구가 동시에 조작하지 않게 하고, 사용자 조작과 겹치면 멈추고 조율한다.
- 제품별 세션 잠금은 OS 화면 잠금이나 도구 간 배타 제어를 보장하지 않는다.
- Chrome Allow·macOS 권한·앱 접근 승인 등 도구 자신의 권한을 GUI로 대신 승인하지 않는다. 필요하면 사용자에게 절차를 안내한다.
- 설치, 활성화·권한 설정, 실제 동작 확인을 구분해 보고한다.

## 저장소에 넣지 않는 기기 상태

다음은 각 기기에서 제품이 관리하게 두고, 저장소·seed·지침에 복사하지 않는다.

- macOS TCC 권한과 앱 접근 승인 목록
- 프로젝트별 MCP 활성화 상태, 앱이 생성한 config 항목·`notify` 명령·내부 경로 ([Codex 설정](codex.md#configtoml을-링크하지-않는-이유))
- 실행 중 PID·target·socket·임시 runtime·CDP endpoint
