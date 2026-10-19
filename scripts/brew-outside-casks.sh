#!/usr/bin/env bash
# Brewfile의 cask 중 Homebrew 밖에서 이미 설치된 것을 한 줄에 하나씩 출력한다: <cask>\t<앱 경로 또는 pkg ID>
# 앱 폴더(/Applications, ~/Applications)의 앱이나 pkg 설치 기록(pkgutil)으로 판단한다.
# homebrew 단계와 doctor가 이 cask들을 설치·검사에서 빼고 그대로 둔다. 확인하지 못하면 아무것도 출력하지 않는다.
set -euo pipefail
brewfile="${1:?사용법: brew-outside-casks.sh <Brewfile>}"
casks="$(sed -n 's/^cask "\([^"]*\)".*/\1/p' "$brewfile")"
[[ -n "$casks" ]] || exit 0
# shellcheck disable=SC2086
json="$(brew info --cask --json=v2 $casks 2>/dev/null)" || exit 0
/usr/bin/python3 -c '
import json, os, subprocess, sys
dirs = ["/Applications", os.path.expanduser("~/Applications")]
for cask in json.loads(sys.argv[1])["casks"]:
    if cask.get("installed"):
        continue
    found = []
    for artifact in cask["artifacts"]:
        app = artifact.get("app")
        if app:
            # ["Foo.app"] 또는 ["Foo.app", {"target": "Bar.app"}]
            target = next((item["target"] for item in app if isinstance(item, dict) and "target" in item), app[0])
            found += [path for path in (os.path.join(d, os.path.basename(target)) for d in dirs) if os.path.exists(path)]
        for uninstall in artifact.get("uninstall", []):
            ids = uninstall.get("pkgutil", [])
            for pkg in [ids] if isinstance(ids, str) else ids:
                listed = subprocess.run(["pkgutil", "--pkgs=" + pkg], capture_output=True, text=True).stdout.strip()
                if listed:
                    found.append("pkg " + listed.splitlines()[0])
    if found:
        print(cask["token"] + "\t" + found[0])
' "$json"
