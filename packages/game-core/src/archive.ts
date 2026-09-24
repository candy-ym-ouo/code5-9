import { ARCHIVE_STAGE_LABELS, type ArchiveStage, type ArchiveStageProgress } from '@shanhai/contracts';
import type { SpeciesDefinition } from './types.ts';

/**
 * 物种档案阶段目标由四类记录合成：
 * 观察次数、采样记录、区域可及（有观察或采样记录的区域数）和保护状态。
 * 指标由服务端按存档聚合，本模块只负责纯规则判定。
 */
export interface ArchiveMetrics {
  observationCount: number;
  sampleCount: number;
  protocolSampleCount: number;
  incorrectSampleCount: number;
  photoSampleCount: number;
  distinctSampleMethods: number;
  recordedSiteCount: number;
  endangeredSiteCount: number;
}

export const EMPTY_ARCHIVE_METRICS: ArchiveMetrics = {
  observationCount: 0,
  sampleCount: 0,
  protocolSampleCount: 0,
  incorrectSampleCount: 0,
  photoSampleCount: 0,
  distinctSampleMethods: 0,
  recordedSiteCount: 0,
  endangeredSiteCount: 0
};

interface ArchiveRequirementRule {
  key: string;
  label: string;
  target: number;
  current: (metrics: ArchiveMetrics) => number;
}

interface ArchiveStageRule {
  stage: ArchiveStage;
  requirements: ArchiveRequirementRule[];
}

function siteTarget(zones: number, desired: number): number {
  return Math.max(1, Math.min(desired, zones));
}

function stageRules(definition: SpeciesDefinition): ArchiveStageRule[] {
  const zoneCount = Math.max(1, Object.keys(definition.zones).length);
  const conservation: ArchiveRequirementRule[] = [
    {
      key: 'no_endangered_sites',
      label: '无濒危区域种群',
      target: 1,
      current: (metrics) => (metrics.endangeredSiteCount === 0 ? 1 : 0)
    }
  ];
  if (definition.protected) {
    conservation.push(
      {
        key: 'photo_samples',
        label: '保护物种影像记录',
        target: 1,
        current: (metrics) => metrics.photoSampleCount
      },
      {
        key: 'no_incorrect_samples',
        label: '保护物种无违规采集',
        target: 1,
        current: (metrics) => (metrics.incorrectSampleCount === 0 ? 1 : 0)
      }
    );
  }

  return [
    {
      stage: 'encountered',
      requirements: [
        { key: 'observations', label: '观察记录', target: 1, current: (metrics) => metrics.observationCount }
      ]
    },
    {
      stage: 'documented',
      requirements: [
        { key: 'observations', label: '观察记录', target: 3, current: (metrics) => metrics.observationCount },
        { key: 'samples', label: '采样记录', target: 1, current: (metrics) => metrics.sampleCount },
        {
          key: 'sites',
          label: '区域可及',
          target: siteTarget(zoneCount, 2),
          current: (metrics) => metrics.recordedSiteCount
        }
      ]
    },
    {
      stage: 'complete',
      requirements: [
        { key: 'observations', label: '观察记录', target: 6, current: (metrics) => metrics.observationCount },
        {
          key: 'protocol_samples',
          label: '符合协议的采样',
          target: 2,
          current: (metrics) => metrics.protocolSampleCount
        },
        {
          key: 'sites',
          label: '区域可及',
          target: siteTarget(zoneCount, 3),
          current: (metrics) => metrics.recordedSiteCount
        },
        ...conservation
      ]
    }
  ];
}

/**
 * 计算各阶段目标达成情况。返回的 unlocked 表示“当前指标是否满足规则”，
 * 持久化锁定（已解锁阶段不回退）由服务端结合 species_archive_unlocks 表合并。
 */
export function evaluateArchiveStages(definition: SpeciesDefinition, metrics: ArchiveMetrics): ArchiveStageProgress[] {
  return stageRules(definition).map((rule) => {
    const requirements = rule.requirements.map((requirement) => {
      const current = requirement.current(metrics);
      return {
        key: requirement.key,
        label: requirement.label,
        current,
        target: requirement.target,
        met: current >= requirement.target
      };
    });
    return {
      stage: rule.stage,
      label: ARCHIVE_STAGE_LABELS[rule.stage],
      unlocked: requirements.every((requirement) => requirement.met),
      unlockedAt: null,
      requirements
    };
  });
}

export function highestUnlockedStage(stages: ArchiveStageProgress[]): ArchiveStage | null {
  let highest: ArchiveStage | null = null;
  for (const stage of stages) {
    if (stage.unlocked) {
      highest = stage.stage;
    }
  }
  return highest;
}
