import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync, readlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setup } from './browser-use-setup.mjs';

const official = '---\nname: browser-use\ndescription: Official test fixture\n---\n';
function fixture(fn) {
  const home = mkdtempSync(join(tmpdir(), 'bootstrap-browser-use-'));
  try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}
function skill(path, text = official) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), text);
}
function cli({ absent = false, broken = false, alias = false, installFails = false } = {}) {
  const calls = [];
  let installed = !absent;
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'browser-use') {
      if (!installed) return { error: { code: 'ENOENT' } };
      if (broken) return { status: 1, stderr: 'broken' };
      assert.ok(['--version', '--help', 'skill'].includes(args[0]), '설치 검사에서 daemon/브라우저 명령 금지');
      return { status: 0, stdout: args[0] === 'skill' ? official : '0.1.13\n' };
    }
    if (command === '/bin/sh') return { status: alias ? 0 : 1, stdout: alias ? '/personal/bu' : '' };
    assert.equal(command, 'uv');
    if (args[0] === 'tool') {
      assert.deepEqual(args, ['tool', 'install', '--python', '3.12', 'browser-use']);
      if (installFails) return { status: 1, stderr: 'offline' };
      installed = true;
    }
    return { status: 0, stdout: 'uv 0.13.1' };
  };
  return { run, calls };
}

const codexSkill = home => join(home, '.agents/skills/browser-use');
const claudeSkill = home => join(home, '.claude/skills/browser-use');

test('새 기기: dry-run 무변경, uv 신규 설치, 양쪽 공식 스킬, 반복/doctor는 갱신 없음', () => fixture(home => {
  const state = cli({ absent: true });
  setup({ home, env: {}, dryRun: true, run: state.run });
  assert.equal(existsSync(join(home, '.agents')), false);
  assert.equal(state.calls.some(c => c[0] === 'uv'), false);
  setup({ home, env: {}, run: state.run });
  for (const path of [codexSkill(home), claudeSkill(home)]) assert.equal(readFileSync(join(path, 'SKILL.md'), 'utf8'), official);
  assert.equal(existsSync(join(home, '.codex')), false, 'Codex 이전 경로에는 설치하지 않음');
  setup({ home, env: {}, run: state.run });
  setup({ home, env: {}, check: true, run: state.run });
  assert.equal(state.calls.filter(c => c[0] === 'uv' && c[1] === 'tool').length, 1);
}));

test('CLAUDE_CONFIG_DIR을 Claude 경로로 쓴다', () => fixture(home => {
  const env = { CLAUDE_CONFIG_DIR: join(home, 'claude-custom') };
  setup({ home, env, run: cli().run });
  assert.equal(readFileSync(join(env.CLAUDE_CONFIG_DIR, 'skills/browser-use/SKILL.md'), 'utf8'), official);
  assert.equal(existsSync(join(home, '.claude')), false);
  setup({ home, env, check: true, run: cli().run });
}));

test('두 provider의 skills가 같은 실제 폴더면 한 번만 배치', () => fixture(home => {
  mkdirSync(join(home, '.agents/skills'), { recursive: true });
  mkdirSync(join(home, '.claude'));
  symlinkSync(join(home, '.agents/skills'), join(home, '.claude/skills'));
  setup({ home, env: {}, run: cli().run });
  assert.equal(readFileSync(join(claudeSkill(home), 'SKILL.md'), 'utf8'), official);
  setup({ home, env: {}, check: true, run: cli().run });
}));

test('개인 스킬·파일·깨진 링크·Codex 이전 경로 중복은 쓰기 전에 보존하고 중단', () => {
  for (const kind of ['personal', 'file', 'broken', 'legacy']) fixture(home => {
    const path = claudeSkill(home);
    mkdirSync(dirname(path), { recursive: true });
    if (kind === 'personal') skill(path, 'personal');
    if (kind === 'file') writeFileSync(path, 'personal');
    if (kind === 'broken') symlinkSync(join(home, 'missing'), path);
    if (kind === 'legacy') skill(join(home, '.codex/skills/browser-use'));
    for (const check of [false, true]) assert.throws(() => setup({ home, env: {}, check, run: cli().run }));
    assert.equal(existsSync(join(home, '.agents')), false);
    if (kind === 'personal') assert.equal(readFileSync(join(path, 'SKILL.md'), 'utf8'), 'personal');
    if (kind === 'file') assert.equal(readFileSync(path, 'utf8'), 'personal');
    if (kind === 'broken') assert.equal(readlinkSync(path), join(home, 'missing'));
    if (kind === 'legacy') assert.equal(existsSync(path), false);
  });
});

test('깨진 CLI 링크는 미설치로 취급하지 않고 보존', () => fixture(home => {
  const bin = join(home, '.local/bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(home, 'missing-cli'), join(bin, 'browser-use'));
  const state = cli({ absent: true });
  assert.throws(() => setup({ home, env: { PATH: bin }, run: state.run }), /교체하지/);
  assert.equal(state.calls.some(c => c[0] === 'uv'), false);
  assert.equal(readlinkSync(join(bin, 'browser-use')), join(home, 'missing-cli'));
}));

test('CLI/별칭/uv 실패 보존과 doctor 누락·다른 내용 검출', () => {
  for (const options of [{ broken: true }, { absent: true, alias: true }, { absent: true, installFails: true }]) fixture(home => {
    const state = cli(options);
    assert.throws(() => setup({ home, env: {}, run: state.run }));
    assert.equal(existsSync(join(home, '.agents')), false);
    if (options.alias || options.broken) assert.equal(state.calls.some(c => c[0] === 'uv'), false);
  });
  fixture(home => {
    const state = cli();
    assert.throws(() => setup({ home, env: {}, check: true, run: state.run }), /누락/);
    assert.equal(existsSync(join(home, '.agents')), false);
    skill(codexSkill(home), 'personal');
    assert.throws(() => setup({ home, env: {}, check: true, run: state.run }), /다릅니다/);
  });
});

const step = fileURLToPath(new URL('./steps/62-browser.sh', import.meta.url));

test('browser 단계 dry-run은 Node 없는 PATH에서도 성공', () => fixture(home => {
  mkdirSync(join(home, 'scripts'));
  mkdirSync(join(home, 'empty-bin'));
  writeFileSync(join(home, 'scripts/lib.sh'), 'info() { printf "%s\\n" "$*"; }\n');
  const result = spawnSync('/bin/bash', [step], {
    env: { ...process.env, BOOTSTRAP_ROOT: home, DRY_RUN: '1', PATH: join(home, 'empty-bin') },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Browser Use/);
}));

test('browser 단계는 Browser Use 실패에도 Chrome 설정을 실행하고 실패를 대기보다 우선한다', () => {
  // [Browser Use 결과, Chrome 결과, 단계 종료 코드]
  for (const [setupStatus, chromeStatus, expected] of [[0, 0, 0], [0, 2, 2], [1, 2, 1], [0, 1, 1]]) fixture(home => {
    mkdirSync(join(home, 'scripts'));
    writeFileSync(join(home, 'scripts/lib.sh'), `
has() { return 0; }
die() { exit 1; }
node() {
  printf '%s\\n' "$1" >> "$BOOTSTRAP_ROOT/calls"
  case "$1" in *browser-use-setup.mjs) return ${setupStatus} ;; *) return ${chromeStatus} ;; esac
}
`);
    const result = spawnSync('/bin/bash', [step], { env: { ...process.env, BOOTSTRAP_ROOT: home, DRY_RUN: '0' }, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    assert.match(readFileSync(join(home, 'calls'), 'utf8'), /browser-settings\.mjs/);
  });
});
