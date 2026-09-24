import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.ts';

export class Store {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec(SCHEMA_SQL);
    this.migrate();
  }

  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(samples)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'slot')) {
      this.db.exec('ALTER TABLE samples ADD COLUMN slot INTEGER NOT NULL DEFAULT 1');
    }

    const applied = this.db
      .prepare('SELECT 1 AS done FROM schema_migrations WHERE key = ?')
      .get('archive_stages') as unknown as { done: number } | undefined;
    if (!applied) {
      this.backfillLegacyArchiveUnlocks();
      this.db
        .prepare('INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)')
        .run('archive_stages', new Date().toISOString());
    }
  }

  /**
   * 旧规则（观察满 3 次即解锁档案）下已经取得的进度需要保留：
   * 对升级前的观察记录补写阶段锁定，幂等，只在迁移首次执行时运行一次。
   */
  private backfillLegacyArchiveUnlocks(): void {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT OR IGNORE INTO species_archive_unlocks (save_id, species_id, stage, source, unlocked_at)
         SELECT save_id, species_id, 'encountered', 'rule', ?
         FROM observations
         WHERE species_id IS NOT NULL
         GROUP BY save_id, species_id
         HAVING COUNT(*) >= 1`
      )
      .run(now);

    this.db
      .prepare(
        `INSERT OR IGNORE INTO species_archive_unlocks (save_id, species_id, stage, source, unlocked_at)
         SELECT o.save_id, o.species_id, 'documented', 'rule', ?
         FROM observations o
         WHERE o.species_id IS NOT NULL
         GROUP BY o.save_id, o.species_id
         HAVING COUNT(*) >= 3
           AND EXISTS (
             SELECT 1 FROM samples s
             WHERE s.save_id = o.save_id AND s.species_id = o.species_id
           )
           AND (
             SELECT COUNT(DISTINCT site_id) FROM (
               SELECT site_id FROM observations WHERE save_id = o.save_id AND species_id = o.species_id
               UNION
               SELECT site_id FROM samples WHERE save_id = o.save_id AND species_id = o.species_id
             )
           ) >= 2`
      )
      .run(now);

    this.db
      .prepare(
        `INSERT OR IGNORE INTO species_archive_unlocks (save_id, species_id, stage, source, unlocked_at)
         SELECT save_id, species_id, 'documented', 'legacy', ?
         FROM observations
         WHERE species_id IS NOT NULL
         GROUP BY save_id, species_id
         HAVING COUNT(*) >= 3`
      )
      .run(now);
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
