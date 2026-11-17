// paseo-plugins.mjs가 Paseo 앱의 Node 런타임으로 실행한다(일반 node는 app.asar를 읽지 못한다).
// 플러그인의 설정 RPC(settings.<id>.read/write, 앱의 플러그인 설정 화면과 같은 경로)로 목록이 정한 키만 덮어쓴다.
// 공개 CLI 명령이 아니라 앱 내부 모듈이라 Paseo 버전에 따라 경로·함수가 바뀔 수 있다. 실패하면 앱의 플러그인 설정에서 맞춘다.
try {
  const { connectToDaemon } = await import(process.env.BOOTSTRAP_PASEO_CLIENT);
  const wanted = JSON.parse(process.env.BOOTSTRAP_PLUGIN_SETTINGS);
  const client = await connectToDaemon({ target: { kind: 'instance', home: process.env.BOOTSTRAP_PASEO_HOME }, timeout: 30_000 });
  let failed = false;
  try {
    for (const { plugin, id, values } of wanted) {
      const current = await client.invokePluginRpc(plugin, `settings.${id}.read`, {});
      if (current?.status !== 'ready') {
        console.log(`설정 읽기 실패: ${plugin} ${id} (${current?.error ?? current?.status})`);
        failed = true;
        continue;
      }
      const result = await client.invokePluginRpc(plugin, `settings.${id}.write`, { revision: current.revision, values: { ...current.values, ...values } });
      console.log(`설정 맞춤: ${plugin} ${id} → ${result?.status}${result?.error ? ` (${result.error})` : ''}`);
      if (result?.status !== 'saved') failed = true;
    }
  } finally {
    await client.close();
  }
  process.exit(failed ? 1 : 0);
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(1);
}
