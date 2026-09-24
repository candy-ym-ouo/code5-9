import { describe, expect, it } from 'vitest';
import { evaluateArchiveStage, getArchiveStageGoals, isArchiveStageMet } from './archive.ts';
import { SPECIES_BY_ID } from './catalog.ts';

describe('species archive stage goals', () => {
  it('caps site goals by the number of accessible zones', () => {
    const metasequoia = SPECIES_BY_ID.get('metasequoia-glyptostroboides')!;
    expect(Object.keys(metasequoia.zones)).toHaveLength(2);
    const goals = getArchiveStageGoals(metasequoia);
    expect(goals.find((goal) => goal.stage === 3)?.requirements.sites).toBe(2);
    expect(goals.find((goal) => goal.stage === 4)?.requirements.sites).toBe(2);

    const carex = SPECIES_BY_ID.get('carex-community')!;
    expect(Object.keys(carex.zones)).toHaveLength(4);
    const carexGoals = getArchiveStageGoals(carex);
    expect(carexGoals.find((goal) => goal.stage === 4)?.requirements.sites).toBe(3);
  });

  it('lowers sample goals for protected species', () => {
    const protectedGoals = getArchiveStageGoals(SPECIES_BY_ID.get('metasequoia-glyptostroboides')!);
    expect(protectedGoals.find((goal) => goal.stage === 2)?.requirements.samples).toBe(0);
    expect(protectedGoals.find((goal) => goal.stage === 4)?.requirements.samples).toBe(2);

    const regularGoals = getArchiveStageGoals(SPECIES_BY_ID.get('prunus-davidiana')!);
    expect(regularGoals.find((goal) => goal.stage === 2)?.requirements.samples).toBe(1);
    expect(regularGoals.find((goal) => goal.stage === 4)?.requirements.samples).toBe(3);
  });

  it('keeps the first stage aligned with the legacy three-observation unlock', () => {
    for (const species of SPECIES_BY_ID.values()) {
      const stageOne = getArchiveStageGoals(species).find((goal) => goal.stage === 1)!;
      expect(stageOne.requirements.observations).toBe(3);
      expect(stageOne.requirements.samples).toBe(0);
      expect(stageOne.requirements.sites).toBe(1);
      expect(stageOne.requirements.statuses).toBe(1);
    }
  });

  it('evaluates the highest completed stage from synthesized progress', () => {
    const goals = getArchiveStageGoals(SPECIES_BY_ID.get('prunus-davidiana')!);
    expect(evaluateArchiveStage(goals, { observations: 0, samples: 0, sites: 0, statuses: 0 })).toBe(0);
    expect(evaluateArchiveStage(goals, { observations: 3, samples: 0, sites: 1, statuses: 1 })).toBe(1);
    expect(evaluateArchiveStage(goals, { observations: 5, samples: 1, sites: 1, statuses: 1 })).toBe(2);
    expect(evaluateArchiveStage(goals, { observations: 6, samples: 2, sites: 2, statuses: 1 })).toBe(3);
    expect(evaluateArchiveStage(goals, { observations: 9, samples: 3, sites: 3, statuses: 2 })).toBe(4);
    // 缺少任一维度都无法进入对应阶段
    expect(evaluateArchiveStage(goals, { observations: 12, samples: 3, sites: 3, statuses: 1 })).toBe(3);
    expect(evaluateArchiveStage(goals, { observations: 12, samples: 0, sites: 3, statuses: 2 })).toBe(1);
  });

  it('keeps stage requirements monotonic so higher stages imply lower ones', () => {
    for (const species of SPECIES_BY_ID.values()) {
      const goals = getArchiveStageGoals(species);
      const fullProgress = { observations: 99, samples: 99, sites: 99, statuses: 99 };
      expect(evaluateArchiveStage(goals, fullProgress)).toBe(goals.length);
      for (const goal of goals) {
        expect(isArchiveStageMet(goal, fullProgress)).toBe(true);
      }
      for (let index = 1; index < goals.length; index += 1) {
        const previous = goals[index - 1]!.requirements;
        const current = goals[index]!.requirements;
        expect(current.observations).toBeGreaterThanOrEqual(previous.observations);
        expect(current.samples).toBeGreaterThanOrEqual(previous.samples);
        expect(current.sites).toBeGreaterThanOrEqual(previous.sites);
        expect(current.statuses).toBeGreaterThanOrEqual(previous.statuses);
      }
    }
  });
});
