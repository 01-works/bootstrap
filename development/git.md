# git · GitHub

## 계정과 인증

- GitHub 계정: `01-office` (조직 `01-works` 멤버)
- 커밋 작성자: [`home/git/.gitconfig`](../home/git/.gitconfig). 이메일은 GitHub noreply 주소를 쓴다.
- git은 **https + gh 자격 증명**으로 GitHub에 접속한다. `gh auth login` 한 번이면 push/pull이 된다. 토큰은 gh가 관리하고 저장소에는 들어가지 않는다.

## SSH 키

- 기기마다 새로 만든다. 다른 기기의 개인키를 복사해 오지 않는다.
- 다른 기기·서버에 SSH로 접속할 때 쓴다. `auth` 단계에서 키가 없으면 만들지 물어본다.
- 자동 설정의 기본 경로는 `~/.ssh/id_ed25519`다. `.pub`만 있거나 기본 개인키 파일이 비어 있으면 불완전한 상태로 알리고 파일을 덮어쓰지 않는다. 공개키의 용도를 확인해 따로 보관한 뒤 기본키를 새로 만들거나, 다른 이름의 키를 직접 만들어 SSH 설정에 지정한다. 기존 사용자 지정 키는 자동으로 바꾸지 않는다. 파일 존재 확인과 실제 서버 접속 검증은 별개다.
- git은 https로 쓰므로 GitHub에는 등록하지 않는다. 나중에 GitHub에 SSH로 붙거나 SSH 커밋 서명이 필요해지면 `gh auth refresh -s admin:public_key` 후 `gh ssh-key add`.
- `~/.ssh/config`는 저장소에 넣지 않는다. 기기마다 접속할 곳이 다르고, colima 같은 도구가 스스로 고쳐 쓴다.

## 기기별 설정

이 기기에서만 필요한 git 설정은 `~/.gitconfig.local`에 둔다. `.gitconfig`가 마지막에 include한다.

## 이 저장소의 커밋 전 검사

`.githooks/pre-commit`이 gitleaks로 staged 변경에서 비밀값을 찾는다. gitleaks가 없으면 커밋을 막는다. `xcode` 단계가 git 설치 뒤에 `core.hooksPath`를 설정하고, `doctor`가 켜져 있는지 확인한다.

훅은 `git commit --no-verify`로 건너뛸 수 있다. 그래서 GitHub에 처음 올리기 전에는 전체 기록을 한 번 검사한다: `gitleaks git --redact`
