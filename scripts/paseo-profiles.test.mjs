import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeProfiles } from './paseo-profiles.mjs';

const manifest = JSON.parse(readFileSync(new URL('../agents/paseo-profiles.json', import.meta.url), 'utf8'));
const script = new URL('./paseo-profiles.mjs', import.meta.url).pathname;

test('역할마다 프로필 하나: 일상 역할은 Opus·Sol, Fable·Astra는 정책 검토 전용', () => {
  for (const [name, model, modeId, thinkingOptionId] of [
    ['Supervisor', 'claude-opus-5-5', 'bypassPermissions', 'high'],
    ['Architect', 'claude-opus-5-5', 'bypassPermissions', 'xhigh'],
    ['Deep Reviewer', 'claude-opus-5-5', 'bypassPermissions', 'high'],
    ['Policy Reviewer (Fable)', 'claude-fable-5-2', 'bypassPermissions', 'high'],
    ['Policy Reviewer (Astra)', 'gpt-6.2-astra', 'auto-review', 'xhigh'],
  ]) {
    const profile = manifest.profiles.find(p => p.name === name);
    assert.deepEqual([profile.model, profile.modeId, profile.thinkingOptionId],
      [model, modeId, thinkingOptionId], name);
  }
  // 비용 때문에 Fable·Astra는 정책 검토 프로필에만 둔다. 모델 대체 프로필은 두지 않는다.
  assert.deepEqual(manifest.profiles.filter(p => /fable|astra/i.test(p.model ?? '')).map(p => p.name),
    ['Policy Reviewer (Fable)', 'Policy Reviewer (Astra)']);
  for (const name of ['Policy Reviewer (Fable)', 'Policy Reviewer (Astra)']) {
    const notes = manifest.profiles.find(p => p.name === name).notes;
    assert.match(notes, /에만 쓰는 읽기 전용 검토자/, name);
    assert.match(notes, /그 밖의 리뷰에는 쓰지 않는다/, name);
  }
  for (const profile of manifest.profiles) {
    assert.doesNotMatch(profile.notes ?? '', /한도 소진|대체 프로필/, profile.name);
  }
});

test('Opus (agy)는 역할 없이 사용자가 직접 고르는 선택용 프로필이다', () => {
  const profile = manifest.profiles.find(p => p.name === 'Opus (agy)');
  assert.deepEqual([profile.provider, profile.model, profile.modeId],
    ['antigravity', 'claude-opus-5-5-high', 'full-access']);
  assert.match(profile.notes, /사용자가 직접 고를 때만 쓰고 Supervisor는 자동으로 고르지 않는다/);
  assert.match(profile.notes, /감독 작업과 브라우저 작업에는 쓰지 않/);
});

test('보조 리뷰 프로필은 수정하지 않는 모드로 실행하고 권한 자동 승인을 켜지 않는다', () => {
  for (const [name, provider, model, modeId] of [
    ['Scan Reviewer', 'antigravity', 'gemini-4-neon-high', 'full-access'],  // Antigravity의 유일한 모드
    ['Gemini Cross-check', 'antigravity', 'gemini-4-neon-high', 'full-access'],
  ]) {
    const profile = manifest.profiles.find(p => p.name === name);
    assert.deepEqual([profile.provider, profile.model, profile.modeId], [provider, model, modeId], name);
    assert.equal(profile.featureValues?.auto_accept, undefined, name);
    assert.match(profile.notes, /바꾸지 말라고 명시/, name);
  }
  assert.match(manifest.profiles.find(p => p.name === 'Scan Reviewer').notes, /비밀값이 있는 저장소에는 쓰지 않는다/);
  // 없앤 프로필은 기기에서 지우도록 removed에만 남긴다.
  for (const { id, name } of manifest.removed ?? []) {
    assert.ok(!manifest.profiles.some(p => p.id === id || p.name === name), name);
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
  // 갱신 없이는 이전 이름을 그대로 두고 새 이름의 프로필을 따로 추가하지 않는다.
  assert.equal(mergeProfiles(existing, manifest).profiles.some(p => p.name === 'Deep Reviewer'), false);
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

test('저장소에서 없앤 프로필은 저장소 ID일 때만 명시적 갱신에서 지우고, 이전 이름은 새 이름으로 이어진다', () => {
  const target = { id: 'bootstrap-new', name: 'New Reviewer', provider: 'codex', model: 'm' };
  const migration = {
    renames: { 'Old Reviewer': 'New Reviewer' },
    removed: [{ id: 'bootstrap-gone', name: 'Gone' }, { id: 'bootstrap-gone-2', name: 'Gone 2' }],
    profiles: [target],
  };
  const existing = [
    { id: 'bootstrap-gone', name: 'Gone', provider: 'codex' },
    { id: 'mine', name: 'Gone 2', provider: 'claude' },
    { id: 'y', name: 'Old Reviewer', provider: 'codex', color: 'blue' },
  ];
  const kept = mergeProfiles(existing, migration);
  assert.deepEqual(kept.profiles.slice(0, 2), existing.slice(0, 2));
  assert.ok(kept.drift.includes('Gone') && kept.drift.includes('Gone 2'));
  const result = mergeProfiles(existing, migration, true);
  assert.equal(result.profiles.some(p => p.id === 'bootstrap-gone'), false);
  assert.ok(result.changes.includes('제거: Gone'));
  // 이름만 같은 개인 프로필은 지우지 않고 차이로 알린다.
  assert.ok(result.profiles.some(p => p.id === 'mine'));
  assert.ok(result.drift.includes('Gone 2'));
  const renamed = result.profiles.find(p => p.id === 'y');
  assert.deepEqual([renamed.name, renamed.model, renamed.color], ['New Reviewer', 'm', 'blue']);
  assert.deepEqual(mergeProfiles(result.profiles, migration, true).changes, []);
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
