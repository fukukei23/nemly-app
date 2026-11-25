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
  /** sensor セッションのメタ（v2 列・csv では undefined） */
  validRatio?: number;
  gapCount?: number;
  endReason?: string;
  /**
   * ネイティブ側セッションID（v3 列・spec §6 冪等キー）。
   * UNIQUE index 付き・同一 native_session_id の再 insert は二重登録防止の
   * 防御層で拒否する（spec §6 重複防止3層）。
   */
  nativeSessionId?: string;
}

/** 同一 native_session_id の再 insert（insert 後 kill の次回回収で冪等に拾う契約） */
export class DuplicateNativeSessionError extends Error {
  constructor(sessionId: string) {
    super(`native_session_id already imported: ${sessionId}`);
    this.name = "DuplicateNativeSessionError";
  }
}

/** v4 統計永続化: failCheck 判定統計スナップショット（設計 §7・INSERT OR IGNORE 初回 immutable） */
export interface VerdictRecord {
  nativeSessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  endReason: string | null;
  verdict: "pass" | "degraded_pass" | "fail";
  reasons: string[];
  stationaryRate: number;
  sleepWindowStationaryRate: number | null;
  stationaryGateActive: boolean;
  nanRate: number;
  validRatio: number;
  expectedWindows: number;
  actualWindows: number;
  judgedAt: string; // ISO
}

/** saveImportArtifacts の amplitude 行型（quality 契約: 0=OK〔≥160 イベント〕/1=DEGRADED〔<160〕） */
export interface AmplitudeSampleRow {
  tsMs: number;
  amplitude: number;
  quality: 0 | 1;
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
  /** native_session_id で既存 sleep_sessions 行を照合する（spec §6 重複防止①事前照合） */
  getSessionIdByNativeId(nativeSessionId: string): Promise<number | null>;
  /**
   * v4 統計永続化: 判定統計 + 生窓値のアトミック保存（設計 §6-7）
   * 単一トランザクションで amplitudes（INSERT OR IGNORE）と verdicts
   * （INSERT OR IGNORE・初回のみ記録・既存 verdict と値不一致時は上書きせずログ警告）を書く。
   * トランザクション内で外部 I/O（native bridge 呼出等）は行わない。
   */
  saveImportArtifacts(verdict: VerdictRecord, samples: AmplitudeSampleRow[]): Promise<void>;
  /** v4 検証用: native_session_id で判定統計行を取得（朝回収照合・テスト） */
  getVerdictByNativeId(nativeSessionId: string): Promise<VerdictRecord | null>;
  /** v4 検証用: native_session_id の生窓値行数（朝回収照合・テスト） */
  countAmplitudeSamples(nativeSessionId: string): Promise<number>;
}

/**
 * InMemory 実装: テスト用。SQLite と等価な API を提供。
 */
export class InMemoryRepository implements Repository {
  private sessions: SessionRecord[] = [];
  private stages: Map<number, SleepStageRow[]> = new Map();
  private nextId = 1;
  private verdicts: Map<string, VerdictRecord> = new Map();
  private amplitudeRows: (AmplitudeSampleRow & { nativeSessionId: string })[] = [];

  async insertSession(session: SessionRecord, stages: SleepStageRow[]): Promise<number> {
    // UNIQUE(native_session_id) 相当（SQLite UNIQUE INDEX と等価契約・spec §6③防御層）
    if (session.nativeSessionId !== undefined) {
      const existing = await this.getSessionIdByNativeId(session.nativeSessionId);
      if (existing !== null) throw new DuplicateNativeSessionError(session.nativeSessionId);
    }
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

  async getSessionIdByNativeId(nativeSessionId: string): Promise<number | null> {
    const found = this.sessions.find((s) => s.nativeSessionId === nativeSessionId);
    return found?.id ?? null;
  }

  async saveImportArtifacts(verdict: VerdictRecord, samples: AmplitudeSampleRow[]): Promise<void> {
    const existing = this.verdicts.get(verdict.nativeSessionId);
    if (existing) {
      // INSERT OR IGNORE: 初回のみ記録・上書きしない。値不一致なら警告（RM-2・judged_at は非決定なので除外比較）
      const { judgedAt: _ea, ...restE } = existing;
      const { judgedAt: _en, ...restN } = verdict;
      if (JSON.stringify(restE) !== JSON.stringify(restN)) {
        console.warn(
          `[v4] verdict mismatch on re-import: ${verdict.nativeSessionId}（既存行を保持・上書きしない）`
        );
      }
      return;
    }
    this.verdicts.set(verdict.nativeSessionId, { ...verdict });
    const seen = new Set(
      this.amplitudeRows
        .filter((r) => r.nativeSessionId === verdict.nativeSessionId)
        .map((r) => r.tsMs)
    );
    for (const s of samples) {
      if (!seen.has(s.tsMs)) {
        this.amplitudeRows.push({ nativeSessionId: verdict.nativeSessionId, ...s });
      }
    }
  }

  async getVerdictByNativeId(nativeSessionId: string): Promise<VerdictRecord | null> {
    const found = this.verdicts.get(nativeSessionId);
    return found ? { ...found } : null;
  }

  async countAmplitudeSamples(nativeSessionId: string): Promise<number> {
    return this.amplitudeRows.filter((r) => r.nativeSessionId === nativeSessionId).length;
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

export async function getSessionByNativeId(
  nativeSessionId: string
): Promise<number | null> {
  return activeRepository.getSessionIdByNativeId(nativeSessionId);
}

export async function saveImportArtifacts(
  verdict: VerdictRecord,
  samples: AmplitudeSampleRow[]
): Promise<void> {
  return activeRepository.saveImportArtifacts(verdict, samples);
}

export async function getVerdictByNativeId(
  nativeSessionId: string
): Promise<VerdictRecord | null> {
  return activeRepository.getVerdictByNativeId(nativeSessionId);
}

export async function countAmplitudeSamples(nativeSessionId: string): Promise<number> {
  return activeRepository.countAmplitudeSamples(nativeSessionId);
}
