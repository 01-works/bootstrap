import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeProfiles } from './paseo-profiles.mjs';

const manifest = JSON.parse(readFileSync(new URL('../agents/paseo-profiles.json', import.meta.url), 'utf8'));
const script = new URL('./paseo-profiles.mjs', import.meta.url).pathname;

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
require('node:assert/strict').deepEqual(args.slice(0, 4), ['daemon', 'config', 'set', 'daemon.agentProfiles']);
const target = path.join(args[6], 'config.json');
const config = JSON.parse(fs.readFileSync(target, 'utf8'));
config.daemon.agentProfiles = JSON.parse(args[4]);
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
    delete actual.daemon.agentProfiles;
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
