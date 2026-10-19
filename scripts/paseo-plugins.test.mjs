import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitSource, planPlugins, validate } from './paseo-plugins.mjs';

const manifest = JSON.parse(readFileSync(new URL('../agents/paseo-plugins.json', import.meta.url), 'utf8'));
const script = new URL('./paseo-plugins.mjs', import.meta.url).pathname;
const gitPlugins = manifest.plugins.filter(plugin => gitSource(plugin.source));
const registryPlugins = manifest.plugins.filter(plugin => !gitSource(plugin.source));

// 데몬이 보고하는 형태의 설치 기록
function installed(plugin, revision, extra = {}) {
  const git = gitSource(plugin.source);
  const identity = git ? { kind: 'git', ...git } : { kind: 'npm', registry: { url: 'https://plugins.paseo.sh', id: plugin.source } };
  return { id: plugin.id, enabled: true, status: 'running', installation: { identity, currentRevision: revision }, ...extra };
}

test('목록 검증: git은 커밋 전체 해시, 레지스트리는 version', () => {
  validate(manifest);
  assert.ok(gitPlugins.length && registryPlugins.length);
  assert.throws(() => validate({ plugins: [{ id: 'a', source: 'github:o/r:a', ref: 'main' }] }));
  assert.throws(() => validate({ plugins: [{ id: 'a', source: 'o/a' }] }));
  assert.throws(() => validate({ plugins: [{ id: 'a', source: 'npm:a', version: '1' }] }));
  assert.throws(() => validate({ plugins: [{ id: 'a', source: 'o/a', version: '1' }, { id: 'a', source: 'o/b', version: '1' }] }));
});

test('계획: 버전 차이만 맞추고 개발용 폴더·다른 소스·꺼진 플러그인은 유지', () => {
  const [mine, other] = gitPlugins;
  const [registry] = registryPlugins;
  const listed = [
    installed(mine, '0'.repeat(40)),
    { id: other.id, enabled: true, status: 'running', installation: { identity: { kind: 'directory', path: '/dev/x' } } },
    installed(registry, registry.version, { enabled: false, status: 'disabled' })
  ];
  const plan = planPlugins({ pluginsEnabled: true }, manifest, listed);
  assert.deepEqual(plan.update.map(item => item.plugin.id), [mine.id]);
  assert.deepEqual(plan.dev.map(item => item.id), [other.id]);
  assert.deepEqual(plan.disabled, [registry.id]);
  assert.deepEqual(plan.install, manifest.plugins.filter(p => ![mine, other, registry].includes(p)));

  const foreign = planPlugins({ pluginsEnabled: true }, manifest, [installed({ ...mine, source: 'github:fork/repo:x' }, mine.ref)]);
  assert.deepEqual(foreign.foreign.map(item => item.id), [mine.id]);
  assert.deepEqual(foreign.update, []);

  // 데몬이 꺼져 있으면 설정의 ID만 본다.
  const offline = planPlugins({ plugins: { [mine.id]: { enabled: true } } }, manifest, null);
  assert.equal(offline.enable, true);
  assert.deepEqual(offline.install.map(p => p.id), manifest.plugins.filter(p => p !== mine).map(p => p.id));
  assert.deepEqual(offline.update, []);
});

test('CLI: 데몬 꺼짐이면 목록이 바뀐 경우에만 잠시 켜고, 결과를 다시 읽어 실패를 잡고, 재실행은 무변경', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-paseo-plugins-test-'));
  try {
    const home = join(dir, 'paseo');
    const bin = join(dir, 'bin');
    mkdirSync(home); mkdirSync(bin);
    const configPath = join(home, 'config.json');
    const calls = join(dir, 'calls');
    const daemon = join(dir, 'daemon-running');
    // CLI 호출 계약만 대역으로 검증. 데몬 대신 config.json의 plugins에 설치 기록을 둔다.
    writeFileSync(join(bin, 'paseo'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const opt = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const target = path.join(opt('--home'), 'config.json');
const config = JSON.parse(fs.readFileSync(target, 'utf8'));
const plugins = config.plugins ??= {};
const save = () => fs.writeFileSync(target, JSON.stringify(config));
fs.appendFileSync(${JSON.stringify(calls)}, args.filter(a => a !== '--home' && a !== opt('--home')).join(' ') + '\\n');
const up = fs.existsSync(${JSON.stringify(daemon)});
if (args[0] === 'daemon' && args[1] === 'start') { fs.writeFileSync(${JSON.stringify(daemon)}, ''); process.exit(0); }
if (args[0] === 'daemon' && args[1] === 'stop') { fs.rmSync(${JSON.stringify(daemon)}, { force: true }); process.exit(0); }
if (args.slice(0, 4).join(' ') === 'daemon config set pluginsEnabled') { config.pluginsEnabled = JSON.parse(args[4]); save(); process.exit(0); }
if (!up) { console.log(JSON.stringify({ error: { code: 'DAEMON_NOT_RUNNING' } })); process.exit(1); }
const pin = process.env.REGISTRY_PIN;
if (args[1] === 'ls') {
  console.log(JSON.stringify(Object.entries(plugins).map(([id, p]) => ({ id, enabled: true, status: process.env.BROKEN_ID === id ? 'error' : 'running', installation: p.installation }))));
} else if (args[1] === 'install') {
  const id = opt('--id');
  if (process.env.FAIL_ID === id) process.exit(1);
  const m = /^github:([^:]+):(.+)$/.exec(args[2]);
  plugins[id] = { installation: m
    ? { identity: { kind: 'git', remote: 'https://github.com/' + m[1] + '.git', pluginPath: m[2] }, currentRevision: opt('--ref') ?? 'head' }
    : { identity: { kind: 'npm', registry: { id: args[2] } }, currentRevision: pin } };
  save();
} else if (args[1] === 'update' && args.includes('--check')) {
  if (process.env.CHECK_FAIL) { console.log(JSON.stringify([{ id: args[2], outcome: 'error', error: 'registry down' }])); process.exit(1); }
  console.log(JSON.stringify([{ id: args[2], outcome: 'update', target: { kind: 'npm', version: pin } }]));
} else if (args[1] === 'update') {
  if (process.env.SILENT_UPDATE) process.exit(0);
  plugins[args[2]].installation.currentRevision = opt('--ref') ?? pin;
  save();
} else process.exit(9);
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PASEO_HOME: home, XDG_STATE_HOME: join(dir, 'state'), DRY_RUN: '0' };
    const run = (args = [], extra = {}) => spawnSync(process.execPath, [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
    const [registry] = registryPlugins;
    const old = gitPlugins[0];
    writeFileSync(configPath, JSON.stringify({
      daemon: {},
      plugins: {
        [old.id]: installed(old, '0'.repeat(40))
      }
    }));
    const initial = readFileSync(configPath, 'utf8');
    assert.equal(run(['--dry-run']).status, 0);
    assert.equal(run(['--check']).status, 1);
    assert.equal(readFileSync(configPath, 'utf8'), initial);
    assert.equal(existsSync(daemon), false, 'check·dry-run은 데몬을 켜지 않는다');

    const [missingGit] = gitPlugins.filter(plugin => plugin !== old);
    const callList = () => readFileSync(calls, 'utf8').trim().split('\n');
    const synced = () => existsSync(join(dir, 'state/bootstrap/paseo-plugins'));

    // 꺼져 있던 데몬은 잠시 켰다가 끈다. 레지스트리 검토 버전이 승인 버전과 다르면 유지하고 알리기만 한다.
    rmSync(calls, { force: true });
    const failed = run([], { FAIL_ID: missingGit.id, REGISTRY_PIN: '0.0.1' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, new RegExp(missingGit.id));
    assert.match(failed.stdout, /레지스트리 검토 버전\(0\.0\.1\)/);
    assert.ok(callList().includes('daemon start --timeout 120') && callList().at(-1) === 'daemon stop');
    assert.equal(existsSync(daemon), false, '켰던 데몬을 다시 끈다');
    const afterFail = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(afterFail.pluginsEnabled, true);
    assert.equal(afterFail.plugins[old.id].installation.currentRevision, old.ref);
    assert.equal(synced(), false, '실패하면 동기화 기록을 남기지 않는다');

    // 레지스트리 확인 실패와 설치 후 실행 안 됨은 실패로 보고한다.
    const broken = run([], { CHECK_FAIL: '1', BROKEN_ID: missingGit.id, REGISTRY_PIN: registry.version });
    assert.equal(broken.status, 1);
    assert.match(broken.stdout, /레지스트리 확인 실패/);
    assert.match(broken.stderr, new RegExp(`${missingGit.id}\\(error\\)`));
    assert.match(broken.stderr, new RegExp(`[ ,]${registry.id}[,.]`));
    assert.equal(synced(), false);

    const applied = run([], { REGISTRY_PIN: registry.version });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const final = JSON.parse(readFileSync(configPath, 'utf8')).plugins;
    for (const plugin of manifest.plugins) assert.equal(final[plugin.id].installation.currentRevision, plugin.ref ?? plugin.version);
    assert.equal(synced(), true);

    // 동기화한 목록 그대로면 데몬이 꺼져 있어도 켜지 않고 끝난다.
    rmSync(calls);
    assert.equal(run().status, 0);
    assert.equal(run(['--check']).status, 0);
    assert.deepEqual(callList(), ['plugin ls --json', 'plugin ls --json']);

    // 켜져 있던 데몬은 끄지 않는다. 명령이 성공해도 버전이 안 바뀌었으면 실패다.
    writeFileSync(daemon, '');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.plugins[old.id].installation.currentRevision = '0'.repeat(40);
    writeFileSync(configPath, JSON.stringify(config));
    assert.equal(run(['--check']).status, 1);
    assert.equal(run([], { SILENT_UPDATE: '1' }).status, 1);
    rmSync(calls);
    assert.equal(run().status, 0);
    assert.equal(existsSync(daemon), true);
    assert.equal(callList().includes('daemon stop'), false);
    assert.equal(run(['--check']).status, 0);
    // 다른 Paseo 홈은 따로 기록한다.
    assert.equal(run(['--home', join(dir, 'missing')]).status, 2);
    assert.equal(existsSync(join(dir, 'missing')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
