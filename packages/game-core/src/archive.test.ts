import { describe, expect, it } from 'vitest';
import {
  EMPTY_ARCHIVE_METRICS,
  evaluateArchiveStages,
  highestUnlockedStage,
  type ArchiveMetrics
} from './archive.ts';
import { SPECIES_BY_ID } from './catalog.ts';

const prunus = SPECIES_BY_ID.get('prunus-davidiana')!;
const metasequoia = SPECIES_BY_ID.get('metasequoia-glyptostroboides')!;

function metrics(overrides: Partial<ArchiveMetrics>): ArchiveMetrics {
  return { ...EMPTY_ARCHIVE_METRICS, ...overrides };
}

describe('species archive stage goals', () => {
  it('keeps every stage locked without records', () => {
    const stages = evaluateArchiveStages(prunus, EMPTY_ARCHIVE_METRICS);
    expect(stages.every((stage) => !stage.unlocked)).toBe(true);
    expect(highestUnlockedStage(stages)).toBeNull();
  });

  it('unlocks encountered with a single observation', () => {
    const stages = evaluateArchiveStages(prunus, metrics({ observationCount: 1 }));
    expect(stages[0]!.stage).toBe('encountered');
    expect(stages[0]!.unlocked).toBe(true);
    expect(stages[1]!.unlocked).toBe(false);
    expect(highestUnlockedStage(stages)).toBe('encountered');
  });

  it('synthesizes documented from observations, samples and two accessible sites', () => {
    const stages = evaluateArchiveStages(
      prunus,
      metrics({ observationCount: 3, sampleCount: 1, recordedSiteCount: 2 })
    );
    const documented = stages.find((stage) => stage.stage === 'documented')!;
    expect(documented.unlocked).toBe(true);
    expect(documented.requirements.map((requirement) => requirement.key)).toEqual([
      'observations',
      'samples',
      'sites'
    ]);

    const shortOfSites = evaluateArchiveStages(
      prunus,
      metrics({ observationCount: 3, sampleCount: 1, recordedSiteCount: 1 })
    );
    expect(highestUnlockedStage(shortOfSites)).toBe('encountered');

    const shortOfSamples = evaluateArchiveStages(
      prunus,
      metrics({ observationCount: 3, recordedSiteCount: 2 })
    );
    expect(highestUnlockedStage(shortOfSamples)).toBe('encountered');
  });

  it('requires conservation-safe complete archives with three accessible sites', () => {
    const complete = evaluateArchiveStages(
      prunus,
      metrics({ observationCount: 6, sampleCount: 2, protocolSampleCount: 2, recordedSiteCount: 3 })
    );
    const completeStage = complete.find((stage) => stage.stage === 'complete')!;
    expect(completeStage.unlocked).toBe(true);
    expect(completeStage.requirements.map((requirement) => requirement.key)).toContain('no_endangered_sites');
    expect(highestUnlockedStage(complete)).toBe('complete');

    const endangered = evaluateArchiveStages(
      prunus,
      metrics({
        observationCount: 6,
        sampleCount: 2,
        protocolSampleCount: 2,
        recordedSiteCount: 3,
        endangeredSiteCount: 1
      })
    );
    expect(highestUnlockedStage(endangered)).toBe('documented');
  });

  it('adds photo and no-violation conservation goals for protected species', () => {
    const stages = evaluateArchiveStages(
      metasequoia,
      metrics({
        observationCount: 6,
        sampleCount: 2,
        protocolSampleCount: 2,
        photoSampleCount: 1,
        recordedSiteCount: 2
      })
    );
    const completeStage = stages.find((stage) => stage.stage === 'complete')!;
    expect(completeStage.requirements.map((requirement) => requirement.key)).toEqual([
      'observations',
      'protocol_samples',
      'sites',
      'no_endangered_sites',
      'photo_samples',
      'no_incorrect_samples'
    ]);
    expect(completeStage.unlocked).toBe(true);

    const noPhoto = evaluateArchiveStages(
      metasequoia,
      metrics({ observationCount: 6, sampleCount: 2, protocolSampleCount: 2, recordedSiteCount: 2 })
    );
    expect(highestUnlockedStage(noPhoto)).toBe('documented');

    const withViolation = evaluateArchiveStages(
      metasequoia,
      metrics({
        observationCount: 6,
        sampleCount: 2,
        protocolSampleCount: 2,
        photoSampleCount: 1,
        incorrectSampleCount: 1,
        recordedSiteCount: 2
      })
    );
    expect(highestUnlockedStage(withViolation)).toBe('documented');
  });

  it('caps site targets at the catalog zone count', () => {
    const stages = evaluateArchiveStages(
      metasequoia,
      metrics({
        observationCount: 6,
        sampleCount: 2,
        protocolSampleCount: 2,
        photoSampleCount: 1,
        recordedSiteCount: 2
      })
    );
    const sitesRequirement = stages
      .find((stage) => stage.stage === 'complete')!
      .requirements.find((requirement) => requirement.key === 'sites')!;
    expect(sitesRequirement.target).toBe(2);
  });
});
