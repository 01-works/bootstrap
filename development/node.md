# Node

| 도구 | 설치 | 비고 |
|---|---|---|
| Node | fnm (`brew "fnm"`) | 기본 버전 24 (`runtimes` 단계의 `NODE_VERSION`) |
| pnpm | corepack | 전역 패키지 위치 `~/Library/pnpm` (`PNPM_HOME`) |

## fnm

`.zshrc`에서 `fnm env --use-on-cd --version-file-strategy recursive`로 켠다.

- 프로젝트 폴더에 들어가면 `.node-version`/`.nvmrc`를 찾아 자동으로 버전을 바꾼다. 상위 폴더까지 찾는다.
- 로그인 셸(`.zprofile`)에는 기본 버전 경로(`~/.local/share/fnm/aliases/default/bin`)를 넣는다. 그래서 `.zshrc`를 읽지 않는 비대화형 셸에서도 `node`가 잡힌다.

## pnpm 설치 방법

Node 다운로드 페이지가 안내하는 corepack 방식을 쓴다(`npm install -g corepack` → `corepack enable pnpm`). corepack은 Node 25부터 Node에 들어 있지 않으므로, 없으면 전역으로 설치한다. 현재 pnpm 문서(pnpm 12)는 Node 없이 도는 단독 실행 파일 설치를 안내한다. corepack을 유지하는 이유는 [TOOLS.md](../TOOLS.md)의 "공식 권장과 다르게 하는 것".

corepack은 Node 버전마다 따로 켜야 한다. 다른 Node 버전으로 고정된 프로젝트에서 `pnpm`이 없다고 나오면, 그 폴더에서 `corepack enable pnpm`을 한 번 실행한다.

## 전역 npm 패키지

전역 패키지는 Node 버전별로 따로 깔린다. 기본 버전을 바꾸면 사라진 것처럼 보인다. 그래서 CLI 도구는 npm 전역으로 설치하지 않는다 (Codex도 공식 설치 스크립트로 설치한다).
