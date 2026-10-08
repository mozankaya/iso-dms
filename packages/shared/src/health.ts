/** Answer of GET /api/health (PROJECT.md 11.1). */
export type HealthState = 'up' | 'down' | 'disabled';

export interface HealthDto {
  /** `down`: the database or the files cannot be reached; `degraded`: only the queue or the editor is down */
  status: 'ok' | 'degraded' | 'down';
  checks: {
    database: HealthState;
    storage: HealthState;
    /** `disabled` when background jobs are switched off */
    redis: HealthState;
    editor: HealthState;
  };
}
