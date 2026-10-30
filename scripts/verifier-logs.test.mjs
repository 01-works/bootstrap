import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./verifier-logs.sh', import.meta.url));

// 임시 HOME의 로그 디렉터리. sshd가 강제 명령에 주는 것처럼 요청 명령을 SSH_ORIGINAL_COMMAND로 넘긴다.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-verifier-logs-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), logs = join(home, '.local/state/verifier/logs');
  mkdirSync(join(logs, 'nightly'), { recursive: true });
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(logs, 'a.log'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  writeFileSync(join(logs, 'nightly/run-1.log'), 'nightly ok\n');
  writeFileSync(join(logs, '-n'), 'dash file\n');
  writeFileSync(join(root, 'outside/secret'), 'secret\n');
  symlinkSync(join(root, 'outside/secret'), join(logs, 'link.log'));
  symlinkSync(join(root, 'outside'), join(logs, 'outdir'));
  const ssh = command => spawnSync('/bin/bash', [script], {
    env: { PATH: '/usr/bin:/bin', HOME: home, ...(command === undefined ? {} : { SSH_ORIGINAL_COMMAND: command }) }, encoding: 'utf8',
  });
  return { root, home, logs, ssh };
}

test('허용 명령: ls, tail [-n N] <파일>, cat <파일> (하위 디렉터리 포함)', t => {
  const f = fixture(t);
  let result = f.ssh('ls');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /a\.log/);
  assert.match(result.stdout, /run-1\.log/);
  result = f.ssh('cat nightly/run-1.log');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'nightly ok\n');
  result = f.ssh('tail a.log');
  assert.equal(result.stdout.split('\n').filter(Boolean).length, 10, '기본 10줄');
  result = f.ssh('tail -n 2 a.log');
  assert.equal(result.stdout, 'line 29\nline 30\n');
  assert.equal(f.ssh('tail -n 10000 a.log').stdout.split('\n').filter(Boolean).length, 30);
  assert.equal(f.ssh('tail -n 0 a.log').stdout, '');
  assert.equal(f.ssh('cat ./a.log').status, 0);
  assert.equal(f.ssh('cat -n').stdout, 'dash file\n', '-로 시작하는 이름도 옵션이 아니라 파일');
});

test('거부(2): 로그 디렉터리 밖, .., 절대 경로, 링크, 디렉터리, 알 수 없는 명령, -n 범위', t => {
  const f = fixture(t);
  for (const command of [
    undefined, '', 'rm a.log', 'sh -c id', 'ls ..', 'ls -la /', 'cat', 'cat a.log nightly/run-1.log',
    'cat ../../../.ssh/authorized_keys', 'cat nightly/../a.log', 'cat /etc/passwd', 'cat link.log', 'cat outdir/secret',
    'cat nightly', 'cat missing.log', 'cat a.log;id', 'cat $(id)', 'cat a*', 'cat a.log|id',
    'tail -n 10001 a.log', 'tail -n -5 a.log', 'tail -n abc a.log', 'tail -n 5', 'tail -f a.log', 'tail -n 5 a.log extra',
  ]) {
    const result = f.ssh(command);
    assert.equal(result.status, 2, `${command}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, '', `${command}: 아무것도 보여 주지 않는다`);
    assert.match(result.stderr, /거부/);
  }
});

test('로그 디렉터리가 없으면 1', t => {
  const f = fixture(t);
  rmSync(join(f.home, '.local/state/verifier'), { recursive: true });
  assert.equal(f.ssh('ls').status, 1);
  assert.equal(f.ssh('cat a.log').status, 1);
});
