import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { SEASON_LABELS } from '@shanhai/contracts';
import { api } from '../api.ts';
import { useGame } from '../game-context.tsx';
import { PlantGlyph } from '../components/PlantGlyph.tsx';

export function SpeciesPage() {
  const { speciesId = '' } = useParams();
  const { world } = useGame();
  const detail = useQuery({
    queryKey: ['species', world.saveId, speciesId],
    queryFn: () => api.getSpecies(world.saveId, speciesId)
  });
  const currentSnapshot =
    world.sites.flatMap((site) => site.species).find((species) => species.id === speciesId) ??
    detail.data?.states[0];

  if (detail.isLoading) return <p className="empty-copy">正在读取物种档案…</p>;
  if (detail.isError || !detail.data) return <p className="form-error">没有找到该物种档案。</p>;

  return (
    <div className="document-page species-document">
      <header className="document-heading">
        <div>
          <p className="eyebrow">SPECIES DOSSIER</p>
          <h1>{detail.data.species.name}</h1>
          <p><i>{detail.data.species.latinName}</i> · {detail.data.species.lifeForm}</p>
        </div>
        <Link className="button button-quiet" to="/play">返回山林</Link>
      </header>

      <section className="dossier-hero">
        <div className="dossier-illustration">
          {currentSnapshot ? <PlantGlyph species={currentSnapshot} large /> : <div className="glyph-placeholder" />}
        </div>
        <div>
          <p className="dossier-description">{detail.data.species.description}</p>
          <dl className="dossier-facts">
            <div><dt>保护状态</dt><dd>{detail.data.species.protected ? '禁止破坏性采集' : '常规观察对象'}</dd></div>
            <div><dt>适宜温度</dt><dd>{detail.data.species.preferred.temperatureC}°C</dd></div>
            <div><dt>适宜湿度</dt><dd>{detail.data.species.preferred.humidity}%</dd></div>
            <div><dt>推荐采集</dt><dd>{detail.data.species.sampleProtocol.join('、')}</dd></div>
          </dl>
        </div>
      </section>

      {detail.data.archive && (
        <section className="document-section">
          <div className="section-heading">
            <div><p className="eyebrow">ARCHIVE STAGES</p><h2>档案阶段</h2></div>
            <span className={`status-pill ${detail.data.archive.unlocked ? 'status-stable' : ''}`}>
              {detail.data.archive.unlocked
                ? `已解锁阶段 ${detail.data.archive.stage} / {detail.data.archive.maxStage}`
                : '档案未解锁'}
            </span>
          </div>
          <dl className="dossier-facts archive-metrics">
            <div><dt>观察次数</dt><dd>{detail.data.archive.progress.observations}</dd></div>
            <div><dt>采样记录</dt><dd>{detail.data.archive.progress.samples}</dd></div>
            <div><dt>区域可及</dt><dd>{detail.data.archive.progress.sites}</dd></div>
            <div><dt>保护状态</dt><dd>{detail.data.archive.progress.statuses}</dd></div>
          </dl>
          <div className="archive-goals">
            {detail.data.archive.goals.map((goal) => (
              <article key={goal.stage} className={goal.met ? 'archive-goal archive-goal-met' : 'archive-goal'}>
                <strong>阶段 {goal.stage} · {goal.label}</strong>
                <span>
                  观察 {Math.min(detail.data.archive!.progress.observations, goal.requirements.observations)}/{goal.requirements.observations}
                  {' · '}采样 {Math.min(detail.data.archive!.progress.samples, goal.requirements.samples)}/{goal.requirements.samples}
                  {' · '}区域 {Math.min(detail.data.archive!.progress.sites, goal.requirements.sites)}/{goal.requirements.sites}
                  {' · '}状态 {Math.min(detail.data.archive!.progress.statuses, goal.requirements.statuses)}/{goal.requirements.statuses}
                </span>
                <small>{goal.met ? '已解锁' : '未达成'}</small>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="document-section">
        <div className="section-heading">
          <div><p className="eyebrow">CURRENT DISTRIBUTION</p><h2>当前区域状态</h2></div>
        </div>
        <div className="state-table">
          {detail.data.states.map((state) => (
            <article key={`${state.id}-${state.population}`}>
              <strong>{state.name}</strong>
              <span>种群 {state.population.toFixed(0)} / {state.carryingCapacity}</span>
              <span>健康 {state.health.toFixed(0)}</span>
              <span>种子库 {state.seedBank.toFixed(0)}</span>
              <span className={`status-pill status-${state.status}`}>{state.status}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="document-section two-document-columns">
        <div>
          <p className="eyebrow">OBSERVATION HISTORY</p>
          <h2>最近观察</h2>
          <div className="timeline-list">
            {detail.data.observations.length === 0 && <p className="empty-copy">还没有观察记录。</p>}
            {detail.data.observations.map((entry) => (
              <article key={entry.id}>
                <span>{entry.year} 年 · {SEASON_LABELS[entry.season as keyof typeof SEASON_LABELS] ?? entry.season}季 · 第 {entry.day} 日</span>
                <strong>{entry.score.toFixed(0)} 分</strong>
                <small>{String(entry.feedback.message ?? '记录已保存')}</small>
              </article>
            ))}
          </div>
        </div>
        <div>
          <p className="eyebrow">ANNUAL TREND</p>
          <h2>年度变化</h2>
          <div className="timeline-list">
            {detail.data.history.length === 0 && <p className="empty-copy">完成第一年年度结算后将显示趋势。</p>}
            {detail.data.history.map((entry) => (
              <article key={String(entry.year)}>
                <span>{String(entry.year)} 年</span>
                <strong>{formatPercent(Number(entry.populationChangePercent))}</strong>
                <small>健康变化 {Number(entry.healthChange) >= 0 ? '+' : ''}{Number(entry.healthChange).toFixed(1)}</small>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function formatPercent(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}
