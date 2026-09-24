import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { GameCommand, SpeciesArchiveSummary, WorldSnapshot } from '@shanhai/contracts';
import { createApp } from '../src/app.ts';

const OBSERVE_VALUES = {
  phenology: 'early_bloom',
  leafTexture: 'smooth',
  dominantColor: '#e8b4b6',
  temperatureC: 16,
  humidity: 60,
  soilMoisture: 50,
  lightLux: 30000,
  note: ''
} as const;

describe('species archive staged unlocks', () => {
  let app: ReturnType<typeof createApp>['app'];
  let store: ReturnType<typeof createApp>['store'];
  let agent: ReturnType<typeof request.agent>;

  beforeAll(() => {
    const created = createApp({ databasePath: ':memory:', loggerEnabled: false });
    app = created.app;
    store = created.store;
    agent = request.agent(app);
  });

  afterAll(() => store.close());

  it('unlocks stages from synthesized goals and only once under concurrent completion', async () => {
    const createResponse = await agent.post('/api/save').expect(201);
    let world = createResponse.body as WorldSnapshot;

    const archiveOf = (snapshot: WorldSnapshot, speciesId: string): SpeciesArchiveSummary =>
      snapshot.archives.find((archive) => archive.speciesId === speciesId)!;

    // 新档案：所有物种均未解锁，阶段目标已按物种合成
    const initial = archiveOf(world, 'prunus-davidiana');
    expect(initial.stage).toBe(0);
    expect(initial.unlocked).toBe(false);
    expect(initial.maxStage).toBe(4);
    expect(initial.goals.map((goal) => goal.requirements.observations)).toEqual([3, 4, 6, 9]);
    expect(world.sites.flatMap((site) => site.species).every((species) => !species.unlocked)).toBe(true);

    // 前两次观察：仍未达到阶段 1 的 3 次观察
    world = await command(agent, world, { type: 'OBSERVE_PLANT', speciesId: 'prunus-davidiana', values: { ...OBSERVE_VALUES } });
    world = await command(agent, world, { type: 'OBSERVE_PLANT', speciesId: 'prunus-davidiana', values: { ...OBSERVE_VALUES } });
    expect(archiveOf(world, 'prunus-davidiana').stage).toBe(0);

    // 第三次观察：并发发送同一请求，阶段 1 只解锁一次
    const unlockingBody = {
      expectedRevision: world.revision,
      idempotencyKey: 'archive-stage-one-unlock',
      command: {
        type: 'OBSERVE_PLANT',
        speciesId: 'prunus-davidiana',
        values: { ...OBSERVE_VALUES }
      } satisfies GameCommand
    };
    const concurrent = await Promise.all(
      Array.from({ length: 3 }, () => agent.post(`/api/save/${world.saveId}/commands`).send(unlockingBody))
    );
    for (const response of concurrent) {
      expect(response.status).toBe(200);
      expect(response.body.event.id).toBe(concurrent[0]!.body.event.id);
    }
    world = concurrent[0]!.body.world as WorldSnapshot;
    const stageOne = archiveOf(world, 'prunus-davidiana');
    expect(stageOne.stage).toBe(1);
    expect(stageOne.unlocked).toBe(true);
    expect(stageOne.goals[0]?.met).toBe(true);
    expect(stageOne.goals[1]?.met).toBe(false);
    expect(
      world.sites.flatMap((site) => site.species).find((species) => species.id === 'prunus-davidiana')?.unlocked
    ).toBe(true);
    const unlockEffects = concurrent[0]!.body.event.effects.filter((effect: string) => effect.includes('物种档案解锁阶段 1'));
    expect(unlockEffects).toHaveLength(1);
    expect(unlockCount(store, world.saveId, 'prunus-davidiana', 1)).toBe(1);

    // 继续推进到阶段 2（4 次观察 + 1 次采样），并发竞争不同请求只生效一次
    world = await command(agent, world, { type: 'TAKE_SAMPLE', speciesId: 'prunus-davidiana', method: 'photo' });
    const raceBody = (key: string, revision: number) => ({
      expectedRevision: revision,
      idempotencyKey: key,
      command: {
        type: 'OBSERVE_PLANT',
        speciesId: 'prunus-davidiana',
        values: { ...OBSERVE_VALUES }
      } satisfies GameCommand
    });
    const [winner, loser] = await Promise.all([
      agent.post(`/api/save/${world.saveId}/commands`).send(raceBody('archive-stage-two-a', world.revision)),
      agent.post(`/api/save/${world.saveId}/commands`).send(raceBody('archive-stage-two-b', world.revision))
    ]);
    const responses = [winner, loser];
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    world = responses.find((response) => response.status === 200)!.body.world as WorldSnapshot;
    expect(archiveOf(world, 'prunus-davidiana').stage).toBe(2);
    expect(unlockCount(store, world.saveId, 'prunus-davidiana', 2)).toBe(1);

    // 冲突请求刷新版本后重试：不会产生重复解锁，也不会重复播报
    const retry = await agent
      .post(`/api/save/${world.saveId}/commands`)
      .send(raceBody('archive-stage-two-b', world.revision))
      .expect(200);
    world = retry.body.world as WorldSnapshot;
    expect(retry.body.event.effects.filter((effect: string) => effect.includes('物种档案解锁阶段'))).toHaveLength(0);
    expect(unlockCount(store, world.saveId, 'prunus-davidiana', 2)).toBe(1);
    expect(totalUnlockCount(store, world.saveId)).toBe(2);

    // 物种档案接口返回同样的阶段信息
    const detail = await agent.get(`/api/save/${world.saveId}/species/prunus-davidiana`).expect(200);
    expect(detail.body.archive.stage).toBe(2);
    expect(detail.body.archive.progress.observations).toBe(5);
    expect(detail.body.archive.progress.samples).toBe(1);
    expect(detail.body.archive.progress.sites).toBe(1);
    expect(detail.body.archive.progress.statuses).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('backfills existing progress for saves created before staged archives', async () => {
    const legacyAgent = request.agent(app);
    const createResponse = await legacyAgent.post('/api/save').expect(201);
    const world = createResponse.body as WorldSnapshot;

    // 模拟升级前的存档：已有 3 次观察，但没有解锁记录，也未做过回填
    const createdAt = new Date().toISOString();
    const insertObservation = store.db.prepare(
      `INSERT INTO observations
       (id, save_id, year, season, day, slot, site_id, species_id, kind, values_json, score, feedback_json, note, created_at)
       VALUES (?, ?, 1, 'spring', 1, 1, 'foothill', 'prunus-davidiana', 'plant', '{}', 80, '{}', '', ?)`
    );
    for (let index = 0; index < 3; index += 1) {
      insertObservation.run(`legacy-observation-${index}`, world.saveId, createdAt);
    }
    store.db.prepare('UPDATE saves SET archive_synced = 0 WHERE id = ?').run(world.saveId);

    const firstRead = await legacyAgent.get(`/api/save/${world.saveId}/world`).expect(200);
    const firstWorld = firstRead.body as WorldSnapshot;
    const archive = firstWorld.archives.find((entry) => entry.speciesId === 'prunus-davidiana')!;
    expect(archive.stage).toBe(1);
    expect(archive.unlocked).toBe(true);
    expect(
      firstWorld.sites.flatMap((site) => site.species).find((species) => species.id === 'prunus-davidiana')?.unlocked
    ).toBe(true);
    expect(unlockCount(store, world.saveId, 'prunus-davidiana', 1)).toBe(1);

    // 再次读取保持幂等，历史进度不会被重复解锁
    await legacyAgent.get(`/api/save/${world.saveId}/world`).expect(200);
    expect(unlockCount(store, world.saveId, 'prunus-davidiana', 1)).toBe(1);
    expect(totalUnlockCount(store, world.saveId)).toBe(1);

    // 回填的解锁不会在后续指令中重复播报
    const afterWait = await command(legacyAgent, firstWorld, { type: 'WAIT' });
    expect(afterWait.recentEvents[0]?.effects.filter((effect) => effect.includes('物种档案解锁'))).toHaveLength(0);
    expect(totalUnlockCount(store, world.saveId)).toBe(1);
  }, 30_000);
});

async function command(
  agent: ReturnType<typeof request.agent>,
  world: WorldSnapshot,
  commandBody: GameCommand
): Promise<WorldSnapshot> {
  const response = await agent
    .post(`/api/save/${world.saveId}/commands`)
    .send({
      expectedRevision: world.revision,
      idempotencyKey: `archive-test-${world.revision}-${commandBody.type}-${Math.random().toString(16).slice(2)}`,
      command: commandBody
    });
  if (response.status !== 200) {
    throw new Error(`${commandBody.type} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.world as WorldSnapshot;
}

function unlockCount(
  store: ReturnType<typeof createApp>['store'],
  saveId: string,
  speciesId: string,
  stage: number
): number {
  const row = store.db
    .prepare('SELECT COUNT(*) AS count FROM species_archive_unlocks WHERE save_id = ? AND species_id = ? AND stage = ?')
    .get(saveId, speciesId, stage) as unknown as { count: number };
  return Number(row.count);
}

function totalUnlockCount(store: ReturnType<typeof createApp>['store'], saveId: string): number {
  const row = store.db
    .prepare('SELECT COUNT(*) AS count FROM species_archive_unlocks WHERE save_id = ?')
    .get(saveId) as unknown as { count: number };
  return Number(row.count);
}
