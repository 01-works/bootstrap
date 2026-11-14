import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeProfiles } from './paseo-profiles.mjs';

const manifest = JSON.parse(readFileSync(new URL('../agents/paseo-profiles.json', import.meta.url), 'utf8'));
const script = new URL('./paseo-profiles.mjs', import.meta.url).pathname;

test('chief 교차 모델 예외는 설계·심층 검토 4개 프로필에만 두고 인계 조건과 구분한다', () => {
  const exceptions = manifest.profiles.filter(p => (p.notes ?? '').includes('예외:'));
  assert.deepEqual(exceptions.map(p => p.name), [
    'Architect', 'Architect (Astra)', 'Deep Reviewer', 'Deep Reviewer (Astra)'
  ]);
  for (const profile of exceptions) {
    // 제한문이 문장 첫머리에 있어야 한다. "일반 설계에서는 …" 같은 한정어가 붙으면 실패한다.
    // 대체 조건은 그 역할의 기본 Claude 모델을 가리킨다: 설계는 Fable, 심층 리뷰는 Opus.
    const model = profile.name.startsWith('Architect') ? 'Fable' : 'Opus';
    const limit = new RegExp(`${profile.name.endsWith('(Astra)') ? '^' : '\\. '}${model} 한도 소진·접속 불가 시에만 `);
    assert.match(profile.notes, limit);
    assert.match(profile.notes, /예외: yw-chief-supervisor 스킬을 실행 중인 총괄 감독/);
    assert.match(profile.notes, /교차 모델 합의\(감사·완료 판정·운영 정책 설계\)/);
    assert.match(profile.notes, new RegExp(`${model} 가용 여부와 관계없이 Astra를 선택할 수 있다`));
    assert.match(profile.notes, /yw-supervisor의 리뷰·설계와 총괄 감독 자신의 코드 PR 리뷰에는 적용하지 않는다/);
  }
  const supervisor = manifest.profiles.find(p => p.name === 'Supervisor (Astra)');
  assert.match(supervisor.notes, /^Fable 한도 소진·접속 불가 시에만/);
  assert.doesNotMatch(supervisor.notes, /교차 모델|가용 여부와 관계없이/);
  for (const profile of manifest.profiles) {
    assert.doesNotMatch(profile.notes ?? '', /일반 (설계|코드 리뷰)/, profile.name);
  }
});

test('기존 개인 설정 유지, 누락 추가, 반복 실행 시 중복 없음', () => {
  const existing = [{ id: 'user-id', name: 'Builder', provider: 'claude', model: 'custom' },
    { id: 'personal', name: 'Personal', provider: 'codex' }];
  const result = mergeProfiles(existing, manifest);
  assert.deepEqual(result.profiles.slice(0, 2), existing);
  assert.deepEqual(result.drift, ['Builder']);
  assert.equal(result.profiles.length, manifest.profiles.length + 1);
  assert.equal(mergeProfiles(result.profiles, manifest).changes.length, 0);
});

test('명시적 갱신은 ID·외형을 보존하고 제공자 기능을 교체하며 이전 이름을 이전한다', () => {
  const existing = [
    { id: 'a', name: 'Architect', provider: 'codex', icon: 'hammer', featureValues: { plan_mode: true } },
    { id: 'b', name: 'Cross Reviewer', provider: 'claude', color: 'orange' }
  ];
  assert.equal(mergeProfiles(existing, manifest).profiles.filter(p => /Reviewer/.test(p.name)).length, 3);
  const result = mergeProfiles(existing, manifest, true);
  assert.equal(result.profiles.length, manifest.profiles.length);
  assert.equal(result.profiles[0].provider, 'claude');
  assert.equal(result.profiles[0].id, 'a');
  assert.equal(result.profiles[0].icon, 'hammer');
  assert.equal(Object.hasOwn(result.profiles[0], 'featureValues'), false);
  assert.equal(result.profiles[1].name, 'Deep Reviewer');
  assert.equal(result.profiles[1].id, 'b');
  assert.equal(result.profiles[1].color, 'orange');
  assert.deepEqual(mergeProfiles(result.profiles, manifest, true).changes, []);
});

test('중복과 모호한 이전은 쓰기 전에 거부', () => {
  assert.throws(() => mergeProfiles([{ id: 'a', name: 'Same', provider: 'codex' },
    { id: 'b', name: 'Same', provider: 'claude' }], manifest));
  assert.throws(() => mergeProfiles([{ id: 'a', name: 'Deep Reviewer', provider: 'claude' },
    { id: 'b', name: 'Cross Reviewer', provider: 'claude' }], manifest, true));
});

test('CLI 병합: dry-run·check 무변경, 백업 권한, 타 설정 보존, 재실행 무변경', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-paseo-test-'));
  try {
    const home = join(dir, 'paseo');
    const state = join(dir, 'state');
    const bin = join(dir, 'bin');
    mkdirSync(home); mkdirSync(bin);
    const configPath = join(home, 'config.json');
    const original = { version: 1, daemon: { listen: '127.0.0.1:7777', relay: { enabled: false } }, plugins: { enabled: true } };
    writeFileSync(configPath, JSON.stringify(original));
    // CLI 호출 계약만 대역으로 검증. 실제 CLI의 스키마 검증은 별도로 실행한다.
    writeFileSync(join(bin, 'paseo'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
require('node:assert/strict').deepEqual(args.slice(0, 3), ['daemon', 'config', 'set']);
const target = path.join(args[6], 'config.json');
fs.appendFileSync(path.join(path.dirname(args[6]), 'calls'), args[3] + '\\n');
if (process.env.FAIL_KEY === args[3]) process.exit(1);
const config = JSON.parse(fs.readFileSync(target, 'utf8'));
const keys = args[3].split('.');
let node = config;
for (const key of keys.slice(0, -1)) node = node[key] ??= {};
node[keys.at(-1)] = JSON.parse(args[4]);
fs.writeFileSync(target, JSON.stringify(config));
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PASEO_HOME: home, XDG_STATE_HOME: state, DRY_RUN: '0' };
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
    const initial = readFileSync(configPath, 'utf8');
    assert.equal(run('--dry-run').status, 0);
    assert.equal(run('--check').status, 1);
    assert.equal(readFileSync(configPath, 'utf8'), initial);
    assert.equal(existsSync(state), false);
    const applied = run();
    assert.equal(applied.status, 0, applied.stderr);
    const actual = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(actual.daemon.agentProfiles.length, manifest.profiles.length);
    assert.equal(actual.daemon.mcp.injectIntoAgents, true);
    assert.equal(actual.daemon.autoArchiveAfterMerge, false);
    delete actual.daemon.agentProfiles;
    delete actual.daemon.mcp;
    delete actual.daemon.autoArchiveAfterMerge;
    assert.deepEqual(actual, original);
    const backupRoot = join(state, 'bootstrap/backup');
    const backups = readdirSync(backupRoot);
    assert.equal(backups.length, 1);
    const backup = join(backupRoot, backups[0], 'config.json');
    assert.equal(readFileSync(backup, 'utf8'), initial);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.equal(run('--check').status, 0);
    assert.equal(run().status, 0);
    assert.equal(readdirSync(backupRoot).length, 1);
    assert.equal(run('--home', join(dir, 'missing')).status, 2);
    assert.equal(existsSync(join(dir, 'missing')), false);
    writeFileSync(configPath, '{bad json');
    assert.equal(run().status, 1);
    assert.equal(readFileSync(configPath, 'utf8'), '{bad json');

    // 프로필은 맞고 도구만 꺼진 기기: 도구 값만 저장. 저장 실패는 실패로 보고하고 재실행으로 마무리한다.
    const calls = join(dir, 'calls');
    writeFileSync(configPath, JSON.stringify({ daemon: { agentProfiles: manifest.profiles, autoArchiveAfterMerge: false } }));
    rmSync(calls, { force: true });
    assert.equal(run('--check').status, 1);
    const failed = spawnSync(process.execPath, [script], { env: { ...env, FAIL_KEY: 'daemon.mcp.injectIntoAgents' }, encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /injectIntoAgents/);
    assert.equal(run().status, 0);
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['daemon.mcp.injectIntoAgents', 'daemon.mcp.injectIntoAgents']);
    assert.equal(run('--check').status, 0);

    // 이전 bootstrap이 자동 아카이브를 켠 기기: 그 값만 끈다.
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.daemon.autoArchiveAfterMerge = true;
    writeFileSync(configPath, JSON.stringify(config));
    rmSync(calls, { force: true });
    assert.equal(run('--check').status, 1);
    assert.equal(run().status, 0);
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['daemon.autoArchiveAfterMerge']);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).daemon.autoArchiveAfterMerge, false);
    assert.equal(run('--check').status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
