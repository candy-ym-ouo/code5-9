import type { SpeciesDefinition } from './types.ts';

/**
 * 物种档案阶段目标的四项输入维度：
 * 观察次数、采样记录、区域可及（已观察的不同区域数）、保护状态（已记录的不同保护状态数）。
 */
export interface ArchiveProgress {
  observations: number;
  samples: number;
  sites: number;
  statuses: number;
}

export interface ArchiveStageDefinition {
  stage: number;
  key: string;
  label: string;
  requirements: ArchiveProgress;
}

const EMPTY_PROGRESS: ArchiveProgress = { observations: 0, samples: 0, sites: 0, statuses: 0 };

/**
 * 阶段目标的基线阈值。各维度阈值随阶段单调递增，
 * 因此完成较高阶段时必然已完成全部较低阶段。
 */
const BASE_STAGES: ArchiveStageDefinition[] = [
  { stage: 1, key: 'field_notes', label: '观察建档', requirements: { observations: 3, samples: 0, sites: 1, statuses: 1 } },
  { stage: 2, key: 'specimen', label: '样本佐证', requirements: { observations: 4, samples: 1, sites: 1, statuses: 1 } },
  { stage: 3, key: 'distribution', label: '区域分布', requirements: { observations: 6, samples: 2, sites: 2, statuses: 1 } },
  { stage: 4, key: 'conservation', label: '保护档案', requirements: { observations: 9, samples: 3, sites: 3, statuses: 2 } }
];

export const ARCHIVE_MAX_STAGE = BASE_STAGES.length;

export function emptyArchiveProgress(): ArchiveProgress {
  return { ...EMPTY_PROGRESS };
}

/**
 * 将四项维度合成为指定物种的阶段目标：
 * - 区域目标不超过该物种实际可及的区域数量（区域可及）；
 * - 保护物种禁止破坏性剪取，采样目标相应下调（保护状态）。
 */
export function getArchiveStageGoals(
  definition: Pick<SpeciesDefinition, 'zones' | 'protected'>
): ArchiveStageDefinition[] {
  const accessibleSites = Object.keys(definition.zones).length;
  return BASE_STAGES.map((stage) => ({
    stage: stage.stage,
    key: stage.key,
    label: stage.label,
    requirements: {
      observations: stage.requirements.observations,
      samples: definition.protected
        ? Math.max(0, stage.requirements.samples - 1)
        : stage.requirements.samples,
      sites: Math.min(stage.requirements.sites, accessibleSites),
      statuses: stage.requirements.statuses
    }
  }));
}

export function isArchiveStageMet(stage: ArchiveStageDefinition, progress: ArchiveProgress): boolean {
  return (
    progress.observations >= stage.requirements.observations &&
    progress.samples >= stage.requirements.samples &&
    progress.sites >= stage.requirements.sites &&
    progress.statuses >= stage.requirements.statuses
  );
}

/** 返回已完成的最高阶段（0 表示尚未完成任何阶段）。 */
export function evaluateArchiveStage(goals: ArchiveStageDefinition[], progress: ArchiveProgress): number {
  let completed = 0;
  for (const goal of goals) {
    if (isArchiveStageMet(goal, progress)) {
      completed = Math.max(completed, goal.stage);
    }
  }
  return completed;
}
