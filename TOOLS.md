# 도구와 공식 문서

설치 명령은 Brewfile과 `scripts/`에만 둔다. 여기는 도구마다 공식 문서 링크, 우리가 고른 설치 방법, 그 이유만 적는다. 명령어를 문서에 복사해 두면 그 복사본이 먼저 낡기 때문이다.

## 갱신하는 법

- 설치가 실패하거나 설치 방법이 바뀐 것 같으면 먼저 공식 문서를 본다. 그다음 Brewfile·스크립트를 고치고, 그 줄의 확인일을 갱신한다.
- 새 기기를 들이기 전에 표 전체 링크를 한 번 확인한다.

## 기본

| 도구 | 우리 설치 방법 | 공식 문서 | 비고 | 확인일 |
|---|---|---|---|---|
| Xcode 명령줄 도구 | `xcode` 단계 | [Apple](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools/) | | 2026-10-07 |
| Homebrew | `homebrew` 단계 (공식 설치 스크립트) | [docs.brew.sh](https://docs.brew.sh/Installation) | 설치 후 `brew shellenv`를 셸 설정에 넣어야 한다 → [`.zprofile`](home/zsh/.zprofile) | 2026-10-07 |
| Brewfile | `brew bundle` | [docs.brew.sh](https://docs.brew.sh/Brew-Bundle-and-Brewfile) | | 2026-10-07 |
| gh | `Brewfile` | [GitHub](https://github.com/cli/cli/blob/trunk/docs/install_macos.md) | Homebrew가 공식 권장 방법 | 2026-10-07 |
| gitleaks | `Brewfile` | [GitHub](https://github.com/gitleaks/gitleaks) | 기능 추가가 끝나고 보안 패치만 하는 상태. 후속 도구는 Betterleaks | 2026-10-07 |
| Tailscale 앱 | `cask "tailscale-app"` | [tailscale.com](https://tailscale.com/docs/install/mac) | Standalone 버전. 공식 권장 | 2026-10-07 |
| Tailscale 명령어 | `brew "tailscale"` | [tailscale.com](https://tailscale.com/docs/reference/tailscale-cli) | 공식 권장과 다름 (아래 1) | 2026-10-07 |

## Node

| 도구 | 우리 설치 방법 | 공식 문서 | 비고 | 확인일 |
|---|---|---|---|---|
| fnm | `Brewfile` | [GitHub](https://github.com/Schniz/fnm) | Homebrew가 공식 방법 중 하나 | 2026-10-07 |
| Node | fnm (`runtimes` 단계) | [nodejs.org](https://nodejs.org/en/download) | fnm이 공식 권장 방법 중 하나 | 2026-10-07 |
| pnpm | corepack (`runtimes` 단계) | [nodejs.org](https://nodejs.org/en/download), [pnpm.io](https://pnpm.io/installation) | 공식 권장과 다름 (아래 2) | 2026-10-07 |

## 컨테이너

| 도구 | 우리 설치 방법 | 공식 문서 | 비고 | 확인일 |
|---|---|---|---|---|
| colima | `Brewfile.main` | [GitHub](https://github.com/abiosoft/colima) | Homebrew가 첫 번째 방법 | 2026-10-07 |
| docker CLI, compose, buildx | `Brewfile.main` + `containers` 단계 | [Homebrew](https://formulae.brew.sh/formula/docker-compose) | 플러그인 연결이 따로 필요 (아래 3) | 2026-10-07 |

## 에이전트

| 도구 | 우리 설치 방법 | 공식 문서 | 비고 | 확인일 |
|---|---|---|---|---|
| Claude Code | `agents` 단계 (공식 설치 스크립트) | [code.claude.com](https://code.claude.com/docs/en/setup) | 공식 권장. 스스로 업데이트된다 (Homebrew cask는 안 됨) | 2026-10-07 |
| Claude 앱 | `cask "claude"` | [claude.com](https://claude.com/download) | | 2026-10-07 |
| Codex CLI | `cask "codex"` | [learn.chatgpt.com](https://learn.chatgpt.com/docs/codex/cli) | 공식 권장과 다름 (아래 4) | 2026-10-07 |
| ChatGPT 앱 | `cask "chatgpt"` | [learn.chatgpt.com](https://learn.chatgpt.com/docs/app) | 2026-07부터 Codex 앱이 ChatGPT 앱에 합쳐졌다 ([changelog](https://learn.chatgpt.com/docs/changelog)) | 2026-10-07 |
| Paseo | `cask "paseo"` | [paseo.sh/download](https://paseo.sh/download), [paseo.sh/docs](https://paseo.sh/docs) | cask가 앱 안의 `paseo` CLI도 연결한다. 앱 없이 CLI만 쓸 때는 npm `@getpaseo/cli` | 2026-10-07 |
| CodexBar | `cask "steipete/tap/codexbar"` | [codexbar.app](https://codexbar.app/) | Homebrew 공식 cask `codexbar`도 있다 | 2026-10-07 |
| Hermes | 직접 설치 | [nousresearch.com](https://hermes-agent.nousresearch.com/docs/getting-started/installation) | Homebrew 설치는 공식 미지원 (아래 5) | 2026-10-07 |

## 에이전트가 쓰는 도구, 네트워크

| 도구 | 우리 설치 방법 | 공식 문서 | 비고 | 확인일 |
|---|---|---|---|---|
| ripgrep | `Brewfile.main` | [GitHub](https://github.com/BurntSushi/ripgrep) | Homebrew가 공식 방법 | 2026-10-07 |
| ffmpeg | `Brewfile.main` | [ffmpeg.org](https://ffmpeg.org/download.html) | 공식은 소스만 배포한다. Homebrew formula는 커뮤니티 관리 | 2026-10-07 |
| cloudflared | `Brewfile.main` | [Cloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) | Homebrew가 첫 번째 공식 방법 | 2026-10-07 |

## 공식 권장과 다르게 하는 것

1. **Tailscale 명령어**: brew `tailscale`은 데몬을 따로 띄우는 오픈소스 버전이다. 공식 문서는 이 버전을 "숙련된 관리자의 무인 설치용"으로만 권장한다. 앱과 같이 쓸 때 공식 방법은 앱의 설정 → CLI integration → Install Now(`/usr/local/bin/tailscale` 생성)다. 지금 Mac은 brew 명령어가 1.98.5, 앱이 1.102.3으로 버전이 다르다. 계속 쓰기로 해서 남겨 둠.
2. **pnpm**: 현재 pnpm 문서(pnpm 12)는 Node가 필요 없는 단독 실행 파일 설치를 안내하고, corepack 방법은 예전 문서(pnpm.io/10.x)에만 남아 있다. Node 다운로드 페이지는 여전히 `npm install -g corepack` → `corepack enable pnpm`을 안내한다. 지금 Mac이 이 방법을 쓰고 있어서 유지한다. corepack은 Node 25부터 Node에 들어 있지 않다.
3. **docker 플러그인**: Homebrew formula 안내는 `~/.docker/config.json`에 `cliPluginsExtraDirs`를 추가하는 것이다. 우리는 colima FAQ 방식대로 `~/.docker/cli-plugins`에 심볼릭 링크를 만든다. 로그인 정보가 든 `config.json`을 스크립트가 고치지 않기 위해서다.
4. **Codex CLI**: 공식 문서의 기본 탭은 설치 스크립트다. Homebrew cask는 "이것으로도 설치할 수 있다"고 소개되는 공식 대안이다. 다른 앱과 같이 Homebrew로 관리하려고 cask를 쓴다.
5. **Hermes**: 지금 공식 설치 스크립트는 Python, Node, ripgrep, FFmpeg, uv를 스스로 설치한다. 설치 후 `source ~/.zshrc`를 안내하므로 `.zshrc`를 고칠 수 있다. 지금 Mac의 Hermes(2026-06 설치)는 brew `node`와 uv의 Python 3.11을 쓴다. 그래서 Brewfile에 `node`, `ffmpeg`를 남겨 두었다. 새 방식으로 다시 설치하면 둘 다 빼도 되는지 확인할 것.
