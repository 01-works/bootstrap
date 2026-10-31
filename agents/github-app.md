# 에이전트 GitHub 신원 (yw-gh)

에이전트 세션의 `gh`와 git push를 소유자 계정 대신 에이전트 전용 GitHub App 신원으로 실행한다. 에이전트가 연 PR·이슈의 작성자가 `<App 이름>[bot]`이 되어 소유자에게 작성자 알림이 가지 않고, 소유자와 에이전트의 동작이 감사 기록에서 구분된다. 결정과 리뷰 기록은 [#21](https://github.com/01-works/bootstrap/issues/21).

원본은 `scripts/yw-gh.sh`(앞단)와 `scripts/yw-gh-app.mjs`(본체)다. `ghapp` 단계가 모든 기기에 `~/.local/bin/gh`와 `~/.local/share/yw-gh/yw-gh-app.mjs`로 설치한다(복사 후 교체).

**에이전트를 돌리는 모든 기기는 App 키·설정을 배치하거나 기기 단위로 끄기 전까지 에이전트의 gh·push가 실패한다.** 그래서 이 도구를 `main`에 넣는 순서는 App 생성 → 에이전트를 돌리는 모든 기기에 키·설정 또는 끄기 파일 배치 → 병합이다. 설정도 끄기 파일도 없는 기기는 `ghapp` 단계와 `doctor`가 수동 작업 대기로 알린다.

## 동작

| 상황 | gh 명령 | git push (credential helper) |
|---|---|---|
| 사람 터미널 (아래 변수 없음) | 실제 gh 그대로 (소유자) | 실제 gh 그대로 (소유자) |
| 에이전트 모드 | 항상 App 토큰 | 원격 owner가 설정 owner면 App 토큰, 다른 owner면 소유자 |
| 에이전트 모드 + `YW_GH_IDENTITY=owner` | 소유자 (shim이 넣은 토큰은 지움) | 소유자 |
| 끄기 파일 `~/.config/yw-gh-app/disabled`가 있는 기기 | 소유자 | 소유자 |

- 에이전트 모드: `PASEO_AGENT_ID`가 있거나 `YW_GH_IDENTITY=agent`일 때. Paseo 밖에서 직접 띄운 세션은 `YW_GH_IDENTITY=agent`를 설정해야 분리된다.
- gh 명령은 인자나 cwd로 대상을 추론하지 않는다. App이 설치되지 않은 저장소(예: `01-works` 조직)를 `gh`로 다룰 때는 `YW_GH_IDENTITY=owner gh …`로 명시한다. 명시하지 않으면 권한 오류로 실패한다.
- git은 `credential.https://github.com.useHttpPath=true`(`home/git/.gitconfig`)로 원격 경로를 넘긴다. 경로가 없거나 github.com이 아니면 `quit=true`로 멈춘다.
- 에이전트 모드에서 설정·키 누락, 권한 오류, 발급 실패는 오류로 끝난다. 소유자 인증으로 넘어가지 않는다. git credential은 node 없음·본체 실패까지 `quit=true`로 멈춘다. 원격 경로는 `<owner>/<repo>[.git]` 형식만 받는다.
- 기기 단위 끄기: `touch ~/.config/yw-gh-app/disabled`. 에이전트도 소유자 gh를 쓴다(지금까지와 같다). 사람이 명시적으로 고르는 것이며 설치 단계는 만들지 않는다. 다시 켜려면 지운다.
- 모든 분기에서 `GH_PATH`를 앞단 경로로 넘겨서, `gh auth setup-git`이 credential helper에 실제 gh 절대 경로를 적지 않게 한다. 이미 그렇게 적혀 있으면 `ghapp` 단계와 `doctor`가 경고한다. `~/.gitconfig`는 저장소 `home/git/.gitconfig` 링크이므로 저장소에서 그 변경을 되돌린다.
- 에이전트 모드에서 `gh auth login|logout|switch|refresh|setup-git`은 거절한다. 계정 관리는 사람 터미널에서 한다.
- 설치 토큰(1시간)은 `$TMPDIR/yw-gh-app-<uid>/`(700)의 600 파일에 원자적으로 캐시해 만료 5분 전까지 다시 쓴다. 남의 것이거나 권한이 넓거나 형식이 맞지 않는 캐시는 손상으로 보고 새로 발급한다. 잠금은 없다(동시에 캐시가 비면 각자 발급하지만 무해하다).

## App 만들기 (소유자, 한 번)

계정 Settings → Developer settings → GitHub Apps → New GitHub App.

| 항목 | 값 |
|---|---|
| Webhook | Active 끔 |
| Where can this GitHub App be installed? | Only on this account |
| Repository permissions | Contents, Pull requests, Issues, Workflows, Actions: Read and write. Checks, Commit statuses: Read-only. Metadata: Read-only (기본). 나머지 없음 |
| Account permissions | 없음 |

만든 뒤 Install App에서 대상 저장소만 고른다. App ID는 App 설정 화면, 설치 ID는 설치 설정 URL 끝(`…/installations/<ID>`)에 있다.

- Actions 쓰기에는 run 재실행·취소·dispatch와 workflow 비활성화가 함께 들어 있다.
- Secrets 권한이 없어도, App이 고친 workflow가 실행되면 그 실행에 허용된 secret은 쓸 수 있다.
- 소유자 actor를 검사하는 workflow(승격·발행 등)는 App이 dispatch하거나 재실행하면 거부된다. 의도한 동작이다.

## 기기에 키 배치

기기마다 private key를 따로 만든다(App 설정 → Private keys → Generate). 다른 기기의 키를 복사하지 않는다.

```sh
mkdir -m 700 -p ~/.config/yw-gh-app
mv ~/Downloads/<app>.*.private-key.pem ~/.config/yw-gh-app/private-key.pem
chmod 600 ~/.config/yw-gh-app/private-key.pem
printf '{"appId": %s, "installationId": %s, "owner": "%s"}\n' <App ID> <설치 ID> <계정> > ~/.config/yw-gh-app/config.json
chmod 600 ~/.config/yw-gh-app/config.json
./bootstrap.sh --only ghapp
```

- App 설정의 키 목록에 보이는 SHA256 fingerprint와 기기 이름의 대응을 기록해 둔다. 로컬 확인: `openssl rsa -in ~/.config/yw-gh-app/private-key.pem -pubout -outform DER | openssl sha256 -binary | openssl base64`
- 확인: Paseo 에이전트 세션에서 `gh api /installation/repositories --jq '.repositories[].full_name'`이 대상 저장소를 보이고, 사람 터미널의 `gh auth status`는 그대로 소유자다.
- 에이전트를 돌리지 않거나 아직 키를 배치하지 않을 기기는 `touch ~/.config/yw-gh-app/disabled`로 끈다 (`mkdir -m 700 -p ~/.config/yw-gh-app` 먼저).

## 키 교체·폐기

- 교체: 새 키 생성 → 위 절차로 바꿔 넣기 → 에이전트 세션에서 확인 → App 설정에서 이전 키 삭제.
- 유출이 의심되면: 해당 키를 App 설정에서 바로 삭제한다. 설치 토큰은 최대 1시간 유효하므로, 즉시 끊어야 하면 그 토큰을 `DELETE /installation/token`으로 폐기하거나 설치를 잠시 suspend한다.
- 키는 스스로 만료되지 않는다. 키를 가진 쪽은 삭제될 때까지 새 토큰을 발급할 수 있다.

## 한계

- 기본 경로를 분리할 뿐 강한 보안 경계가 아니다. 같은 macOS 사용자로 도는 에이전트는 키체인의 소유자 토큰에 접근할 수 있고, 실제 gh·SDK·curl을 직접 부르면 분리되지 않는다.
- shim이 넣은 토큰은 부모 프로세스로 전파되지 않는다. 오래 도는 명령(`gh run watch` 등)은 토큰이 만료되면 다시 실행한다.
- 이미 소유자 이름으로 열린 PR·이슈는 닫힐 때까지 소유자에게 알림이 간다.
- 범위 밖: `01-works` 조직 저장소(별도 org App), reviewer용 App, nightly status 게시, dev-issue-state 수동 marker 복구(소유자 작업).
