/**
 * Nemly Repository Layer
 *
 * 複製元: microwin-app src/lib/repository.ts（構造継承・2026-10-27）
 *
 * 責務:
 * - sleep_sessions（1晩の記録）の insert/list/delete
 * - sleep_stages（統合ラベル時系列）の session_id 単位読み書き
 * - insert は session と stages を同一トランザクション契約で扱う
 *   （InMemory 実装は単一 Map 操作で等価・SQLite 実装は withExclusiveTransactionAsync 使用）
 *
 * 設計判断:
 * - Interface 抽象化で jest テスト時は InMemory 実装を使用（複製元と同一構造）
 * - 本番では SQLite 実装を動的 import（expo-sqlite は native module のため）
 * - stage の phase は統合ラベル（'DEEP' | 'LIGHT' | 'REM' | 'AWAKE' | 'BROKEN'）
 * - UNIQUE(session_id, ts_ms) 相当の重複防御は InMemory では Map キーで担保
 */

export const STAGE_PHASES = ["DEEP", "LIGHT", "REM", "AWAKE", "BROKEN"] as const;
export type StagePhase = (typeof STAGE_PHASES)[number];

export interface SleepStageRow {
  tsMs: number;
  phase: StagePhase;
}

export interface SessionRecord {
  id?: number;
  startMs: number;
  endMs: number;
  sampleCount: number;
  deepRatio: number;
  lightRatio: number;
  remRatio: number;
  awakeRatio: number;
  score: number | null;
  source: string;
  createdAt: string;
}

export interface SessionWithStages extends SessionRecord {
  stages: SleepStageRow[];
}

export interface Repository {
  /**
   * session と stages を一括保存し、採番された session id を返す。
   * stages が空でも許容（判定失敗時のメタデータのみ保存ケース）。
   */
  insertSession(session: SessionRecord, stages: SleepStageRow[]): Promise<number>;
  listSessions(): Promise<SessionRecord[]>;
  getSessionStages(sessionId: number): Promise<SleepStageRow[]>;
  deleteSession(sessionId: number): Promise<void>;
  countSessions(): Promise<number>;
}

/**
 * InMemory 実装: テスト用。SQLite と等価な API を提供。
 */
class InMemoryRepository implements Repository {
  private sessions: SessionRecord[] = [];
  private stages: Map<number, SleepStageRow[]> = new Map();
  private nextId = 1;

  async insertSession(session: SessionRecord, stages: SleepStageRow[]): Promise<number> {
    const id = this.nextId++;
    this.sessions.push({ ...session, id });
    // 同一 (session_id, ts_ms) の重複を排除（SQLite の UNIQUE INDEX 相当）
    const seen = new Set<number>();
    const deduped = stages.filter((s) => {
      if (seen.has(s.tsMs)) return false;
      seen.add(s.tsMs);
      return true;
    });
    this.stages.set(id, deduped.sort((a, b) => a.tsMs - b.tsMs));
    return id;
  }

  async listSessions(): Promise<SessionRecord[]> {
    // 開始時刻の降順（新しい晩が先頭）
    return [...this.sessions].sort((a, b) => b.startMs - a.startMs);
  }

  async getSessionStages(sessionId: number): Promise<SleepStageRow[]> {
    return [...(this.stages.get(sessionId) ?? [])];
  }

  async deleteSession(sessionId: number): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    this.stages.delete(sessionId);
  }

  async countSessions(): Promise<number> {
    return this.sessions.length;
  }
}

// テスト用: モジュール差し替えで InMemoryRepository を使用
let activeRepository: Repository = new InMemoryRepository();

/**
 * テスト用リポジトリ差し替え。SQLite 実装は実機接続時に追加予定。
 */
export function _setRepositoryForTest(repo: Repository): void {
  activeRepository = repo;
}

export function _resetRepositoryForTest(): void {
  activeRepository = new InMemoryRepository();
}

// ============================================================
// Public API (リポジトリへの薄いラッパー・非同期)
// ============================================================

export async function insertSession(
  session: SessionRecord,
  stages: SleepStageRow[]
): Promise<number> {
  return activeRepository.insertSession(session, stages);
}

export async function listSessions(): Promise<SessionRecord[]> {
  return activeRepository.listSessions();
}

export async function getSessionStages(sessionId: number): Promise<SleepStageRow[]> {
  return activeRepository.getSessionStages(sessionId);
}

export async function deleteSession(sessionId: number): Promise<void> {
  await activeRepository.deleteSession(sessionId);
}

export async function countSessions(): Promise<number> {
  return activeRepository.countSessions();
}
