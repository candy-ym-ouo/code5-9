import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { GameCommand, WorldSnapshot } from '@shanhai/contracts';
import { createApp } from '../src/app.ts';

const OBSERVATION_VALUES = {
  phenology: 'leafing',
  leafTexture: 'smooth',
  dominantColor: '#557a45',
  temperatureC: 16,
  humidity: 60,
  soilMoisture: 50,
  lightLux: 30000,
  note: '阶段目标测试'
} as const;

describe('species archive stage unlocks', () => {
  const runtimes: string[] = [];
  const stores: Array<ReturnType<typeof createApp>['store']> = [];

  afterEach(async () => {
    while (stores.length > 0) {
      stores.pop()?.close();
    }
    while (runtimes.length > 0) {
      const runtime = runtimes.pop();
      if (runtime) {
        await rm(runtime, { recursive: true, force: true });
      }
    }
  });

  async function freshSave() {
    const app = createApp({ databasePath: ':memory:', loggerEnabled: false });
    stores.push(app.store);
    const agent = request.agent(app.app);
    const created = await agent.post('/api/save').expect(201);
    return {
      app,
      agent,
      world: created.body as WorldSnapshot
    };
  }

  async function command(
    agent: ReturnType<typeof request.agent>,
    world: WorldSnapshot,
    commandBody: GameCommand,
    idempotencyKey: string = randomUUID()
  ): Promise<{ status: number; body: any; world: WorldSnapshot | null }> {
    const response = await agent
      .post(`/api/save/${world.saveId}/commands`)
      .send({ expectedRevision: world.revision, idempotencyKey, command: commandBody });
    return {
      status: response.status,
      body: response.body,
      world: (response.body?.world as WorldSnapshot | undefined) ?? null
    };
  }

  function snapshot(world: WorldSnapshot, speciesId: string) {
    return world.sites.flatMap((site) => site.species).find((species) => species.id === speciesId);
  }

  function unlockRowCount(store: ReturnType<typeof createApp>['store'], saveId: string, speciesId: string, stage?: string): number {
    const row = store.db
      .prepare(
        `SELECT COUNT(*) AS count FROM species_archive_unlocks
         WHERE save_id = ? AND species_id = ?${stage ? ' AND stage = ?' : ''}`
      )
      .get(...(stage ? [saveId, speciesId, stage] : [saveId, speciesId])) as unknown as { count: number };
    return Number(row.count);
  }

  it('unlocks stages in order and surfaces every stage requirement', async () => {
    const session = await freshSave();
    let world = session.world;

    const first = await command(session.agent, world, {
      type: 'OBSERVE_PLANT',
      speciesId: 'prunus-davidiana',
      values: { ...OBSERVATION_VALUES }
    });
    expect(first.status).toBe(200);
    world = first.world!;
    expect(first.body.event.type).toBe('OBSERVE_PLANT');
    const encounterEvent = world.recentEvents.find((event) => event.type === 'ARCHIVE_STAGE');
    expect(encounterEvent?.message).toContain('初见记录');
    expect(snapshot(world, 'prunus-davidiana')?.archive.stage).toBe('encountered');
    expect(snapshot(world, 'prunus-davidiana')?.unlocked).toBe(false);
    expect(unlockRowCount(session.app.store, world.saveId, 'prunus-davidiana', 'encountered')).toBe(1);

    world = (
      await command(session.agent, world, { type: 'MOVE_ZONE', siteId: 'mixed_forest' })
    ).world!;
    world = (
      await command(session.agent, world, {
        type: 'OBSERVE_PLANT',
        speciesId: 'prunus-davidiana',
        values: { ...OBSERVATION_VALUES }
      })
    ).world!;
    world = (
      await command(session.agent, world, { type: 'TAKE_SAMPLE', speciesId: 'prunus-davidiana', method: 'photo' })
    ).world!;

    const thirdObservationKey = randomUUID();
    const unlocking = await command(
      session.agent,
      world,
      { type: 'OBSERVE_PLANT', speciesId: 'prunus-davidiana', values: { ...OBSERVATION_VALUES } },
      thirdObservationKey
    );
    expect(unlocking.status).toBe(200);
    world = unlocking.world!;
    expect(snapshot(world, 'prunus-davidiana')?.archive.stage).toBe('documented');
    expect(snapshot(world, 'prunus-davidiana')?.unlocked).toBe(true);
    expect(snapshot(world, 'prunus-davidiana')?.archive.stages[1]?.unlockedAt).toEqual(expect.any(String));

    const staleRevision = await agentPost(
      session.agent,
      { ...world, revision: world.revision - 1 },
      randomUUID(),
      { type: 'OBSERVE_PLANT', speciesId: 'prunus-davidiana', values: { ...OBSERVATION_VALUES } }
    );
    expect(staleRevision.status).toBe(409);
    expect(staleRevision.body.code).toBe('REVISION_CONFLICT');

    const replaySameKey = await agentPost(session.agent, world, thirdObservationKey, {
      type: 'OBSERVE_PLANT',
      speciesId: 'prunus-davidiana',
      values: { ...OBSERVATION_VALUES }
    });
    expect(replaySameKey.status).toBe(200);
    expect(replaySameKey.body.event.id).toBe(unlocking.body.event.id);

    const refetched = await session.agent.get(`/api/save/${world.saveId}/world`).expect(200);
    const refetchedWorld = refetchedWorldOrThrow(refetched.body as WorldSnapshot);
    expect(snapshot(refetchedWorld, 'prunus-davidiana')?.archive.stage).toBe('documented');
    expect(unlockRowCount(session.app.store, world.saveId, 'prunus-davidiana', 'documented')).toBe(1);
    expect(unlockRowCount(session.app.store, world.saveId, 'prunus-davidiana')).toBe(2);
  });

  it('only creates one unlock under concurrent completion', async () => {
    const session = await freshSave();
    const world = session.world;
    const sharedKey = randomUUID();
    const commandBody = {
      type: 'OBSERVE_PLANT',
      speciesId: 'prunus-davidiana',
      values: { ...OBSERVATION_VALUES }
    } as const;

    const [first, second] = await Promise.all([
      agentPost(session.agent, world, sharedKey, commandBody),
      agentPost(session.agent, world, sharedKey, commandBody)
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.event.id).toBe(second.body.event.id);
    expect(unlockRowCount(session.app.store, world.saveId, 'prunus-davidiana', 'encountered')).toBe(1);

    const settledWorld = first.body.world as WorldSnapshot;
    const [winner, loser] = await Promise.all([
      agentPost(session.agent, settledWorld, randomUUID(), { type: 'WAIT' }),
      agentPost(session.agent, settledWorld, randomUUID(), { type: 'WAIT' })
    ]);
    const statuses = [winner.status, loser.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect([winner.body.code, loser.body.code]).toContain('REVISION_CONFLICT');
  });

  it('exposes protected-species conservation goals and can complete a full archive', async () => {
    const session = await freshSave();
    let world = session.world;

    world = (await command(session.agent, world, { type: 'MOVE_ZONE', siteId: 'stream_valley' })).world!;
    world = (
      await command(session.agent, world, {
        type: 'OBSERVE_PLANT',
        speciesId: 'metasequoia-glyptostroboides',
        values: { ...OBSERVATION_VALUES }
      })
    ).world!;

    const firstDetail = await session.agent
      .get(`/api/save/${world.saveId}/species/metasequoia-glyptostroboides`)
      .expect(200);
    const completeGoals = firstDetail.body.archive.stages.find(
      (stage: { stage: string }) => stage.stage === 'complete'
    );
    expect(completeGoals.requirements.map((requirement: { key: string }) => requirement.key)).toEqual([
      'observations',
      'protocol_samples',
      'sites',
      'no_endangered_sites',
      'photo_samples',
      'no_incorrect_samples'
    ]);
    expect(firstDetail.body.archive.stage).toBe('encountered');

    world = (
      await command(session.agent, world, { type: 'TAKE_SAMPLE', speciesId: 'metasequoia-glyptostroboides', method: 'photo' })
    ).world!;
    world = (
      await command(session.agent, world, {
        type: 'OBSERVE_PLANT',
        speciesId: 'metasequoia-glyptostroboides',
        values: { ...OBSERVATION_VALUES }
      })
    ).world!;
    world = (
      await command(session.agent, world, {
        type: 'OBSERVE_PLANT',
        speciesId: 'metasequoia-glyptostroboides',
        values: { ...OBSERVATION_VALUES }
      })
    ).world!;
    world = (await command(session.agent, world, { type: 'MOVE_ZONE', siteId: 'mixed_forest' })).world!;
    for (let index = 0; index < 3; index += 1) {
      world = (
        await command(session.agent, world, {
          type: 'OBSERVE_PLANT',
          speciesId: 'metasequoia-glyptostroboides',
          values: { ...OBSERVATION_VALUES }
        })
      ).world!;
    }

    const completing = await command(session.agent, world, {
      type: 'TAKE_SAMPLE',
      speciesId: 'metasequoia-glyptostroboides',
      method: 'photo'
    });
    expect(completing.status).toBe(200);
    world = completing.world!;
    expect(completing.body.event.type).toBe('TAKE_SAMPLE');
    expect(
      world.recentEvents.some((event) => event.type === 'ARCHIVE_STAGE' && event.message.includes('完整档案'))
    ).toBe(true);
    expect(snapshot(world, 'metasequoia-glyptostroboides')?.archive.stage).toBe('complete');
    expect(snapshot(world, 'metasequoia-glyptostroboides')?.unlocked).toBe(true);
    expect(unlockRowCount(session.app.store, world.saveId, 'metasequoia-glyptostroboides', 'complete')).toBe(1);
  });

  it('backfills legacy observation-based unlocks once and stays idempotent on reopen', async () => {
    const runtime = await mkdtemp(path.join(tmpdir(), 'shanhai-archive-'));
    runtimes.push(runtime);
    const databasePath = path.join(runtime, 'archive-migration.db');

    const first = createApp({ databasePath, loggerEnabled: false });
    stores.push(first.store);
    const legacyCreate = await request(first.app).post('/api/save').expect(201);
    const legacyCookie = String(legacyCreate.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
    if (!legacyCookie) {
      throw new Error('legacy save creation did not return a session cookie');
    }
    const legacySaveId = (legacyCreate.body as WorldSnapshot).saveId;

    const ruleAgent = request.agent(first.app);
    const ruleCreate = await ruleAgent.post('/api/save').expect(201);
    const ruleSaveId = (ruleCreate.body as WorldSnapshot).saveId;

    const now = new Date().toISOString();
    for (const index of [0, 1, 2]) {
      first.store.db
        .prepare(
          `INSERT INTO observations
           (id, save_id, year, season, day, slot, site_id, species_id, kind, values_json,
            score, feedback_json, note, created_at)
           VALUES (?, ?, 1, 'spring', ?, 1, 'foothill', 'prunus-davidiana', 'plant', '{}', 80, '{}', '', ?)`
        )
        .run(randomUUID(), legacySaveId, index + 1, now);
    }

    for (const [index, siteId] of ['foothill', 'foothill', 'mixed_forest'].entries()) {
      first.store.db
        .prepare(
          `INSERT INTO observations
           (id, save_id, year, season, day, slot, site_id, species_id, kind, values_json,
            score, feedback_json, note, created_at)
           VALUES (?, ?, 1, 'spring', ?, 1, ?, 'ginkgo-biloba', 'plant', '{}', 80, '{}', '', ?)`
        )
        .run(randomUUID(), ruleSaveId, index + 1, siteId, now);
    }
    first.store.db
      .prepare(
        `INSERT INTO samples
         (id, save_id, observation_id, year, season, day, slot, site_id, species_id, method,
          protocol_match, effects_json, created_at)
         VALUES (?, ?, NULL, 1, 'spring', 1, 1, 'foothill', 'ginkgo-biloba', 'photo', 1, '{}', ?)`
      )
      .run(randomUUID(), ruleSaveId, now);

    stores.splice(stores.indexOf(first.store), 1);
    first.store.close();

    const raw = new DatabaseSync(databasePath);
    raw.exec("DELETE FROM schema_migrations WHERE key = 'archive_stages'; DROP TABLE species_archive_unlocks;");
    raw.close();

    const migrated = createApp({ databasePath, loggerEnabled: false });
    stores.push(migrated.store);
    const legacyRows = migrated.store.db
      .prepare('SELECT stage, source FROM species_archive_unlocks WHERE save_id = ? ORDER BY stage')
      .all(legacySaveId) as unknown as Array<{ stage: string; source: string }>;
    expect(legacyRows).toEqual([
      { stage: 'documented', source: 'legacy' },
      { stage: 'encountered', source: 'rule' }
    ]);
    const ruleRows = migrated.store.db
      .prepare('SELECT stage, source FROM species_archive_unlocks WHERE save_id = ? ORDER BY stage')
      .all(ruleSaveId) as unknown as Array<{ stage: string; source: string }>;
    expect(ruleRows).toEqual([
      { stage: 'documented', source: 'rule' },
      { stage: 'encountered', source: 'rule' }
    ]);

    const worldResponse = await request(migrated.app)
      .get('/api/save/current')
      .set('Cookie', legacyCookie)
      .expect(200);
    const world = refetchedWorldOrThrow(worldResponse.body.world as WorldSnapshot);
    expect(snapshot(world, 'prunus-davidiana')?.unlocked).toBe(true);
    expect(snapshot(world, 'prunus-davidiana')?.archive.stage).toBe('documented');

    const totalRows = migrated.store.db.prepare('SELECT COUNT(*) AS count FROM species_archive_unlocks').get() as unknown as {
      count: number;
    };
    stores.splice(stores.indexOf(migrated.store), 1);
    migrated.store.close();

    const reopened = createApp({ databasePath, loggerEnabled: false });
    const afterReopen = reopened.store.db.prepare('SELECT COUNT(*) AS count FROM species_archive_unlocks').get() as unknown as {
      count: number;
    };
    expect(Number(afterReopen.count)).toBe(Number(totalRows.count));
    reopened.store.close();
  });
});

async function agentPost(
  agent: ReturnType<typeof request.agent>,
  world: WorldSnapshot,
  idempotencyKey: string,
  command: GameCommand
) {
  const response = await agent
    .post(`/api/save/${world.saveId}/commands`)
    .send({ expectedRevision: world.revision, idempotencyKey, command });
  return { status: response.status, body: response.body as any };
}

function refetchedWorldOrThrow(world: WorldSnapshot): WorldSnapshot {
  if (!world || !Array.isArray(world.sites)) {
    throw new Error('Expected world snapshot in response');
  }
  return world;
}
