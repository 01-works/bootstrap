import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appRuntime, installedSkills, optedOut } from './paseo-skills.mjs';

const script = new URL('./paseo-skills.mjs', import.meta.url).pathname;

function skill(home, dir, name, marker = true) {
  mkdirSync(join(home, dir, name), { recursive: true });
  if (marker) writeFileSync(join(home, dir, name, '.paseo-managed-files.json'), '[]');
}

test('설치 확인: Paseo 표시가 있는 paseo* 폴더만 센다', () => {
  const home = mkdtempSync(join(tmpdir(), 'paseo-skills-'));
  try {
    assert.deepEqual(installedSkills(home), []);
    skill(home, '.claude/skills', 'paseo-help', false);
    skill(home, '.claude/skills', 'yw-supervisor');
    assert.deepEqual(installedSkills(home), []);
    skill(home, '.agents/skills', 'paseo');
    skill(home, '.claude/skills', 'paseo');
    assert.deepEqual(installedSkills(home), ['paseo']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('선택: 앱에서 하나도 고르지 않았을 때만 설치하지 않는다', () => {
  assert.equal(optedOut({}), false);
  assert.equal(optedOut({ skills: { selection: { mode: 'all' } } }), false);
  assert.equal(optedOut({ skills: { selection: { mode: 'custom', skills: ['paseo'] } } }), false);
  assert.equal(optedOut({ skills: { selection: { mode: 'custom', skills: [] } } }), true);
});

test('런타임: 앱 안의 CLI일 때만 찾는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paseo-skills-'));
  try {
    const contents = join(dir, 'Paseo.app/Contents');
    const resources = join(contents, 'Resources');
    mkdirSync(join(resources, 'bin'), { recursive: true });
    writeFileSync(join(resources, 'bin/paseo'), '');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    symlinkSync(join(resources, 'bin/paseo'), join(bin, 'paseo'));
    assert.equal(appRuntime(bin), null);
    mkdirSync(join(contents, 'Frameworks/Paseo Helper.app/Contents/MacOS'), { recursive: true });
    writeFileSync(join(contents, 'Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper'), '');
    mkdirSync(join(resources, 'app.asar.unpacked/dist/daemon'), { recursive: true });
    writeFileSync(join(resources, 'app.asar.unpacked/dist/daemon/node-entrypoint-runner.js'), '');
    writeFileSync(join(resources, 'app.asar'), '');
    assert.match(appRuntime(bin).client, /app\.asar\/node_modules\/@getpaseo\/cli\/dist\/utils\/client\.js$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--check: 설정 없음 2, 스킬 없음 1, 있거나 일부러 뺐으면 0', () => {
  const home = mkdtempSync(join(tmpdir(), 'paseo-skills-'));
  try {
    const paseoHome = join(home, '.paseo');
    const run = () => spawnSync(process.execPath, [script, '--check'], { env: { ...process.env, HOME: home, PASEO_HOME: paseoHome, DRY_RUN: '0' }, encoding: 'utf8' });
    assert.equal(run().status, 2);
    mkdirSync(paseoHome);
    writeFileSync(join(paseoHome, 'config.json'), '{}');
    assert.equal(run().status, 1);
    writeFileSync(join(paseoHome, 'config.json'), JSON.stringify({ skills: { selection: { mode: 'custom', skills: [] } } }));
    assert.equal(run().status, 0);
    writeFileSync(join(paseoHome, 'config.json'), '{}');
    skill(home, '.agents/skills', 'paseo');
    assert.equal(run().status, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
