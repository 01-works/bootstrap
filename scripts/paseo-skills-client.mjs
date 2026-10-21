// paseo-skills.mjs가 Paseo 앱의 Node 런타임으로 실행한다(일반 node는 app.asar를 읽지 못한다).
// 앱 CLI의 데몬 연결 모듈로 기본 스킬이 없을 때만 설치를 요청하고 결과 상태를 출력한다.
// 공개 CLI 명령이 아니라 앱 내부 모듈이라 Paseo 버전에 따라 경로·함수가 바뀔 수 있다. 실패하면 앱 설정에서 설치한다.
try {
  const { connectToDaemon } = await import(process.env.BOOTSTRAP_PASEO_CLIENT);
  const client = await connectToDaemon({ target: { kind: 'instance', home: process.env.BOOTSTRAP_PASEO_HOME }, timeout: 30_000 });
  try {
    const before = await client.getAgentSkillsStatus();
    const after = before.state === 'not-installed' ? await client.reconcileAgentSkills() : before;
    console.log(`Paseo 데몬: ${before.state} → ${after.state}${after.error ? ` (${after.error})` : ''}`);
  } finally {
    await client.close();
  }
  process.exit(0);
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(1);
}
