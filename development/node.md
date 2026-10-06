# Node · JavaScript

| 도구 | 설치 | 비고 |
|---|---|---|
| Node | fnm (`brew "fnm"`) | 기본 버전 24 (`runtimes` 단계의 `NODE_VERSION`) |
| pnpm | corepack | 전역 패키지 위치 `~/Library/pnpm` (`PNPM_HOME`) |
| bun | `brew "oven-sh/bun/bun"` | 공식 설치 스크립트는 `.zshrc`를 고쳐 써서 쓰지 않는다 |

## fnm

`.zshrc`에서 `fnm env --use-on-cd --version-file-strategy recursive`로 켠다.

- 프로젝트 폴더에 들어가면 `.node-version`/`.nvmrc`를 찾아 자동으로 버전을 바꾼다. 상위 폴더까지 찾는다.
- 로그인 셸(`.zprofile`)에는 기본 버전 경로(`~/.local/share/fnm/aliases/default/bin`)를 넣는다. 그래서 `.zshrc`를 읽지 않는 비대화형 셸에서도 `node`가 잡힌다.

## 왜 Node를 brew로 깔지 않나

Node 관리자가 둘이면 어느 `node`가 잡히는지 헷갈린다. fnm 하나로 통일한다.

지금 Mac mini에는 `brew "node"`도 깔려 있다 (2026-10-06). 그걸 쓰는 게 없으면 `brew uninstall node`로 정리한다.

## 전역 npm 패키지

전역 패키지는 Node 버전별로 따로 깔린다. 기본 버전을 바꾸면 사라진 것처럼 보인다. 그래서 CLI 도구는 가능하면 brew나 cask로 설치한다 (예: Codex → `cask "codex"`).
