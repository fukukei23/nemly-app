/**
 * 睡眠スコア計算（仕様メモ §4・10測定項目の合否比率）。
 * SCORE は集計対象外（仕様メモ §4.4・空区間のため表示用メタデータ扱い）。
 */

export type MeasureType = 'RANGE' | 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';

/** セッション種別: night=睡眠帯（22:00-08:00）内開始・nap=睡眠帯外開始 */
export type SessionType = 'night' | 'nap';

export type MeasureKey =
  | 'DURATION'
  | 'DURATION_NAP'
  | 'DEEP_SLEEP'
  | 'EFFICIENCY'
  | 'IRREGULARITY'
  | 'SNORE'
  | 'RATING'
  | 'HR'
  | 'HRV'
  | 'RDI';

export interface MeasureSpec {
  type: MeasureType;
  limitPositive: number;
  limitNegative: number;
}

/**
 * 測定項目のしきい値表（仕様メモ §4.2 を基に DURATION はセッション種別で分岐）。
 * DURATION は 180-480分（3-8時間・ふくけい指示「3-4時間はあり得る・8時間まで幅広く」2026-11-01・
 * 旧値 410-540 は「夜寝7時間超」前提で実睡眠に届かずスコア67固定になった・進捗追記7）。
 * DURATION_NAP は 20-120分（パワーナップ〜1.5サイクル・仕様メモに昼寝の項は無いため自前設計・§4.4的裁量）。
 */
export const MEASURE_SPECS: Record<MeasureKey, MeasureSpec> = {
  DURATION: { type: 'RANGE', limitPositive: 180, limitNegative: 480 },
  DURATION_NAP: { type: 'RANGE', limitPositive: 20, limitNegative: 120 },
  DEEP_SLEEP: { type: 'HIGHER_IS_BETTER', limitPositive: 0.2, limitNegative: 0.1 },
  EFFICIENCY: { type: 'HIGHER_IS_BETTER', limitPositive: 0.95, limitNegative: 0.85 },
  IRREGULARITY: { type: 'HIGHER_IS_BETTER', limitPositive: 0.9, limitNegative: 0.75 },
  SNORE: { type: 'LOWER_IS_BETTER', limitPositive: 0.04, limitNegative: 0.1 },
  RATING: { type: 'HIGHER_IS_BETTER', limitPositive: 3.8, limitNegative: 2.5 },
  HR: { type: 'RANGE', limitPositive: 35, limitNegative: 55 },
  HRV: { type: 'HIGHER_IS_BETTER', limitPositive: 2.0, limitNegative: -5.0 },
  RDI: { type: 'LOWER_IS_BETTER', limitPositive: 10, limitNegative: 20 },
};

export type ScoreColorType = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

export interface MeasureResult {
  /** 表示進捗 0-100（整数・四捨五入後クリップ） */
  progress: number;
  colorType: ScoreColorType;
}

/** 年齢→DURATIONしきい値上書き（仕様メモ §4.3・米国睡眠財団準拠の数値構造） */
const AGE_DURATION_LIMITS: { minAge: number; maxAge: number; pos: number; neg: number }[] = [
  { minAge: 6, maxAge: 13, pos: 540, neg: 720 },
  { minAge: 14, maxAge: 17, pos: 480, neg: 660 },
  { minAge: 18, maxAge: 25, pos: 420, neg: 600 },
  { minAge: 65, maxAge: Infinity, pos: 360, neg: 600 },
];

function clamp100(v: number): number {
  return Math.max(Math.min(v, 100), 0);
}

export class SleepScoreCalculator {
  private score = 0;
  private maxScore = 0;
  private sessionType: SessionType = 'night';
  private durationSpec: MeasureSpec = { ...MEASURE_SPECS.DURATION };

  constructor(private readonly options: { idealSleepMinutes?: number } = {}) {}

  /** 年齢でDURATIONしきい値を上書き（age<=0は無視・§4.3） */
  setAge(age: number): void {
    if (age <= 0) return;
    for (const lim of AGE_DURATION_LIMITS) {
      if (age >= lim.minAge && age <= lim.maxAge) {
        this.durationSpec = { type: 'RANGE', limitPositive: lim.pos, limitNegative: lim.neg };
        return;
      }
    }
    // 26-64歳は初期値のまま
  }

  /** セッション種別で DURATION しきい値を切替（nap は 20-120分固定・年齢しきい値を適用しない） */
  setSessionType(type: SessionType): void {
    this.sessionType = type;
  }

  /** 測定値を入力し合否・進捗・色を得る（呼び出しごとに集計に加算される） */
  updateMeasure(key: MeasureKey, value: number): MeasureResult {
    // nap は setAge の適用順に依存しないよう updateMeasure 時点で常に DURATION_NAP を優先
    const spec =
      key === 'DURATION' && this.sessionType === 'nap'
        ? MEASURE_SPECS.DURATION_NAP
        : key === 'DURATION'
          ? this.durationSpec
          : (MEASURE_SPECS[key] as MeasureSpec);
    this.maxScore++;
    const result = this.evaluate(spec, key, value);
    if (result.passed) this.score++;
    return result;
  }

  getScore(): number {
    return this.score;
  }

  getScoreMax(): number {
    return this.maxScore;
  }

  /** スコアのパーセント（0-100・評価対象0件時は0） */
  getScorePercentage(): number {
    if (this.maxScore === 0) return 0;
    return Math.round((this.score / this.maxScore) * 100);
  }

  private evaluate(spec: MeasureSpec, key: MeasureKey, v: number): MeasureResult & { passed: boolean } {
    switch (spec.type) {
      case 'RANGE': {
        const passed = v >= spec.limitPositive && v <= spec.limitNegative;
        // DURATIONの表示進捗だけは理想睡眠時間ベースの特例（§4.3）
        const progress =
          key === 'DURATION' && this.options.idealSleepMinutes !== undefined
            ? clamp100(Math.round((v / this.options.idealSleepMinutes) * 100))
            : v < spec.limitPositive
              ? clamp100(Math.round((v / spec.limitPositive) * 100))
              : v > spec.limitNegative
                ? clamp100(Math.round((2 - v / spec.limitNegative) * 100))
                : 100;
        // 緩衝帯（仕様メモ §4.1・±25%）
        const colorType: ScoreColorType =
          v >= spec.limitPositive * 0.75 && v <= spec.limitNegative * 1.25 ? 'POSITIVE' : 'NEGATIVE';
        return { progress, colorType, passed };
      }
      case 'HIGHER_IS_BETTER': {
        const passed = v >= spec.limitPositive;
        const base = spec.limitNegative / 2;
        const progress = clamp100(Math.round(((v - base) * 100) / (spec.limitPositive - base)));
        return { progress, colorType: passed ? 'POSITIVE' : 'NEGATIVE', passed };
      }
      case 'LOWER_IS_BETTER': {
        const passed = v <= spec.limitPositive;
        const upper = spec.limitNegative * 2;
        const progress = clamp100(Math.round(((upper - v) * 100) / (upper - spec.limitPositive)));
        return { progress, colorType: passed ? 'POSITIVE' : 'NEGATIVE', passed };
      }
    }
  }
}
