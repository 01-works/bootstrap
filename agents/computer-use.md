# 기기 GUI 작업 (Computer Use)

CLI·API·MCP로 처리할 수 있으면 해당 도구를 우선한다. 웹 UI와 기존 Chrome 작업은 **uv로 설치한 Browser Use CLI의 `browser-use` 명령**과 설치된 공식 `browser-use` 스킬을 기본으로 사용한다([브라우저 운영 규칙](browser.md)). 그 밖의 네이티브 GUI는 아래 제품별 Computer Use 경로를 확인한다.

다른 브라우저 도구가 필요하면 이유를 알리고 사용자와 선택을 조율한다. 지정된 로그인·인증 환경을 임의로 대체하지 않는다.

## 제품과 실행 환경

확인일: **2026-10-19**. 아래는 공식 문서의 지원 조건이며 이 Mac의 실행 성공을 뜻하지 않는다.

| 제품 / 실행 환경 | 경로와 조건 | macOS 권한·승인 대상 |
|---|---|---|
| Browser Use CLI / 터미널·작업자 | uv 도구 환경의 `browser-use` + 공식 스킬. 웹 기본 도구이며 데스크톱 Computer Use 플러그인과 별개 | 기존 Chrome 연결의 사용자 Allow; 브라우저 규칙 유지 |
| Claude Code / 대화형 CLI | macOS, Pro/Max, claude.ai 인증. 내장 `computer-use` MCP를 프로젝트별 활성화. `-p` 비대화형은 지원하지 않음 ([공식](https://code.claude.com/docs/en/computer-use)) | CLI를 실행하는 터미널 앱: 화면 기록·손쉬운 사용 |
| Claude 앱 / Cowork·데스크톱 Claude Code | 앱에서 Computer use 활성화, Pro/Max 조건 확인 ([공식](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)) | Claude 앱의 권한 요청에서 실제 앱명 확인; 대상 앱 접근 승인은 별도 |
| ChatGPT 앱 / Work·Codex | 지원 지역·환경에서 Computer Use 플러그인 활성화 ([공식](https://learn.chatgpt.com/docs/computer-use)) | `Codex Computer Use`: 화면 기록·손쉬운 사용; 앱 접근 승인은 별도 |
| Codex CLI / 터미널 | 위 앱 문서만으로 CLI 가용성을 확인하지 못함. 미지원으로 단정하지 않고 실제 노출 도구 확인 | 미확인 |
| Paseo 작업자 / 제공자 세션 | Computer Use 지원·노출 미검증. 기본 배정하지 않고 확인 후 조율, 없으면 공식 대화형 CLI·앱 경로 안내 | 실제 실행 경로 확인 전 가정하지 않음 |

ChatGPT Browser 플러그인은 로컬 관측상 `browser-use`/`@browser-use` 별칭과 동명일 수 있다. CLI 명령·스킬 원본·플러그인 제공자를 구별한다. 실제 잘못된 라우팅은 재현되지 않았다.

## 수동 활성화

### Claude Code 대화형 CLI

1. 지원 계정으로 `claude` 대화형 세션을 열고 `/mcp`에서 `computer-use` → Enable을 선택한다. 프로젝트별 상태이며 다른 프로젝트에 자동 적용된다고 가정하지 않는다.
2. 사용자가 macOS 설정의 개인정보 보호 및 보안에서 해당 **터미널 앱**의 화면 기록·손쉬운 사용 권한을 확인한다. 화면 기록 반영에 프로세스 재시작이 필요하면 진행 중인 세션 소유자와 조율한다.
3. 대상 앱 사용 요청에 세션별 접근을 사용자가 승인한다. Claude 세션 잠금은 작업 완료 후에도 세션 종료까지 유지될 수 있으므로 소유자와 전환 순서를 정한다.

### Claude 앱

1. 앱에서 Computer use 토글을 확인한다. 현재 Cowork 도움말은 Settings → General(Desktop app) → Enable computer use를 안내한다. 다른 버전 문서에는 This computer → System 경로도 있으므로 실제 메뉴와 공식 안내를 따른다.
2. 사용자가 앱이 요청하는 OS 권한과 대상 앱 접근을 확인한 뒤 Cowork 또는 데스크톱 Claude Code 세션에서 범위를 지정한다. CLI의 터미널 권한과 혼동하지 않는다.

### ChatGPT Work·Codex 앱

1. ChatGPT 앱에서 Work 또는 Codex를 선택하고 Plugins → Computer Use의 설치/Enable 안내를 따른다. server와 skill 토글을 켠다.
2. 사용자가 `Codex Computer Use`의 화면 기록·손쉬운 사용 권한과 Settings → Computer use의 대상 앱 접근을 확인한다.
3. 준비 후 `@Computer` 또는 대상 앱을 명시해 제한된 작업을 요청할 수 있다. 제공자 전용 공식 스킬은 다른 제공자에 복제하지 않는다.

## 설치·설정·동작 확인

- **설치**: 앱·CLI는 기존 bootstrap에서 준비한다([도구별 설치·역할](README.md)). 이 문서는 새 설치기나 wrapper를 추가하지 않는다.
- **설정**: 제품별 수동 활성화, OS 권한, 앱 접근 승인은 별개다. bootstrap/doctor 통과만으로 완료되었다고 보지 않는다.
- **동작 확인**: 실제 노출된 도구·공식 스킬과 대상 앱에서 요청한 결과를 확인해야 한다. 이번 문서 설정 작업에서는 브라우저·Computer Use를 실행하지 않았으며 실제 GUI 동작은 **미검증**이다.

## 조작 순서와 권한

담당자는 기기·대상 앱/창·소유자·조작 차례를 지정한다. 같은 앱을 브라우저 도구와 GUI 도구가 동시에 조작하지 않도록 순차 조율하고, 사용자 조작과 겹치면 중단·인계를 조율한다. 제품별 세션 잠금은 공통 OS 화면 잠금이나 모든 도구 간 배타 제어를 보장하지 않는다.

사용자 권한과 제품별 접근 제한을 준수한다. Chrome Allow·macOS 권한·앱 접근 승인 등 도구 자신의 권한을 GUI로 대신 승인하지 않는다. 수동 승인이 필요하면 사용자에게 해당 절차를 안내한다. 기존 Browser Use의 default daemon/runtime 재사용·own 탭 보존·timeout/재연결 규칙은 그대로 적용한다.

## 영구 저장하지 않는 기기 상태

공통 저장소·seed·지침에 다음 실행 상태를 복사하거나 고정하지 않는다. 각 기기에서 제품이 관리하도록 보존한다.

- macOS TCC 권한과 앱 접근 승인 목록
- 프로젝트별 MCP 활성화 상태, 앱이 생성한 config·`notify` 명령/내부 경로
- 실행 PID·target·socket·임시 runtime·CDP endpoint

직접 선택한 공통 지침과 설치 방법만 관리한다. 기존 개인 설정·공식 스킬을 덮어쓰거나 앱 관리 상태를 수동 재생성하지 않는다([Codex 설정 원칙](codex.md#configtoml을-링크하지-않는-이유)).
