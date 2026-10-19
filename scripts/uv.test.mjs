import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const lib = fileURLToPath(new URL('./lib.sh', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-uv-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(body) {
  return spawnSync('/bin/bash', ['-c', `set -euo pipefail\nsource ${quote(lib)}\n${body}`], {
    env: { ...process.env, DRY_RUN: '0' }, encoding: 'utf8'
  });
}

test('uv 공식 설치: 지정 경로·셸 보존 옵션, 실행 확인, 재실행 시 기존 CLI 유지', t => {
  const root = fixture(t);
  const bin = join(root, 'bin');
  const log = join(root, 'downloads');
  const installer = `set -eu
[ "$UV_NO_MODIFY_PATH" = 1 ]
[ "$UV_INSTALL_DIR" = ${quote(bin)} ]
mkdir -p "$UV_INSTALL_DIR"
cat > "$UV_INSTALL_DIR/uv" <<'CLI'
#!/bin/sh
printf 'uv test\\n'
CLI
chmod +x "$UV_INSTALL_DIR/uv"
`;
  const result = run(`
has() { [[ "$1" == uv && -x ${quote(join(bin, 'uv'))} ]]; }
uv() { ${quote(join(bin, 'uv'))} "$@"; }
curl() {
  [[ "$*" == '-fsSL https://astral.sh/uv/install.sh' ]]
  printf 'download\\n' >> ${quote(log)}
  printf '%s\\n' ${quote(installer)}
}
ensure_standalone_uv ${quote(bin)}
ensure_standalone_uv ${quote(bin)}
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(log, 'utf8'), 'download\n');
  assert.match(result.stdout, /uv test/);
});

test('uv dry-run은 설치기를 받거나 파일을 만들지 않는다', t => {
  const bin = join(fixture(t), 'bin');
  const result = run(`
DRY_RUN=1
has() { return 1; }
curl() { echo 'unexpected download'; return 99; }
ensure_standalone_uv ${quote(bin)}
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(bin), false);
  assert.doesNotMatch(result.stdout + result.stderr, /unexpected download/);
});

test('실행되지 않는 기존 uv와 uv/uvx 파일·깨진 링크는 덮어쓰지 않는다', t => {
  const root = fixture(t);
  const broken = run(`
uv() { return 1; }
curl() { echo 'unexpected download'; return 99; }
ensure_standalone_uv ${quote(join(root, 'unused'))}
`);
  assert.equal(broken.status, 1);
  assert.doesNotMatch(broken.stdout + broken.stderr, /unexpected download/);
  for (const entry of ['uv', 'uvx']) {
    for (const link of [false, true]) {
      const bin = join(root, `${entry}-${link}`);
      const dst = join(bin, entry);
      const missing = join(root, 'missing');
      mkdirSync(bin);
      if (link) symlinkSync(missing, dst);
      else writeFileSync(dst, 'personal binary');
      const result = run(`
has() { return 1; }
curl() { echo 'unexpected download'; return 99; }
ensure_standalone_uv ${quote(bin)}
`);
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout + result.stderr, /unexpected download/);
      if (link) assert.equal(readlinkSync(dst), missing);
      else assert.equal(readFileSync(dst, 'utf8'), 'personal binary');
    }
  }
});

test('uv 다운로드·설치기·설치 후 실행 실패를 성공으로 처리하지 않는다', t => {
  const root = fixture(t);
  for (const [name, download] of [
    ['download', 'return 22'],
    ['installer', "printf 'exit 19\\n'"],
    ['missing-cli', "printf 'exit 0\\n'"],
  ]) {
    const result = run(`
has() { return 1; }
curl() { ${download}; }
ensure_standalone_uv ${quote(join(root, name))}
`);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(existsSync(join(root, name)), false);
  }
});
