/**
 * csvImport（Nemly Phase 1）
 *
 * 責務:
 * - Activity_*.txt 5列形式（cols0=ts・cols2=amp・10秒粒度・ヘッダなし）のパース
 * - sleep-algorithm 判定パイプラインの実行と統合ラベル時系列の生成
 * - セッション記録（比率・スコア）への集約
 *
 * 経路の実績: sleep-algorithm validation/real_data.ts（L141 実機比較検証 93.6% と同一経路）
 *
 * 統合ラベルの優先順位: AWAKE > REM > DEEP > LIGHT > BROKEN
 * スコアは CSV から算出可能な 3 測定（DURATION・DEEP_SLEEP・EFFICIENCY）のみで計算
 * （SNORE/RATING/HR/HRV/RDI/IRREGULARITY は入力列が無いため評価対象外=分母から除外）
 */

import {
  ActivityClassifier,
  SleepPhaseDetector,
  SleepScoreCalculator,
  detectAwakeIntervals,
  postProcessDeepIntervals,
  detectREM,
  type Interval,
  type SleepPhase,
} from "./sleepAlgorithm/index";
import type { SleepStageRow, StagePhase } from "./repository";

/** 原典現行版（v20261006 相当・getMinDeepSleepLength=15分・getDeepSleepThreshold=3.1 固定・正典: hypnogramGeneration.ts の version 対応表） */
const CURRENT_VERSION = 10008;

/** 実機エクスポートのサンプリング粒度（FRAMERATE_MS と同一・10秒） */
const STEP_MS = 10_000;

export interface ParsedSample {
  ts: number;
  amp: number;
}

export interface AnalyzeResult {
  startMs: number;
  endMs: number;
  sampleCount: number;
  deepRatio: number;
  lightRatio: number;
  remRatio: number;
  awakeRatio: number;
  score: number | null;
  stages: SleepStageRow[];
}

export function parseActivityTxt(content: string): ParsedSample[] {
  const out: ParsedSample[] = [];
  // CRLF・BOM 耐性（実機エクスポートの改行コード差異を吸収・MLR r1 MiniMax 指摘）
  const normalized = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = normalized.trim().split("\n");
  for (const line of lines) {
    const cols = line.split(",");
    const ts = Number(cols[0]);
    const amp = Number(cols[2]);
    if (!Number.isFinite(ts) || !Number.isFinite(amp)) continue;
    out.push({ ts, amp });
  }
  return out;
}

function toHypnogramIntervals(
  phases: SleepPhase[],
  samples: ParsedSample[],
): { label: "DEEP" | "LIGHT" | "BROKEN"; start: number; end: number }[] {
  const labelOf = (p: SleepPhase): "DEEP" | "LIGHT" | "BROKEN" =>
    p === "DEEP_SLEEP" ? "DEEP" : p === "LIGHT_SLEEP" ? "LIGHT" : "BROKEN";
  const out: { label: "DEEP" | "LIGHT" | "BROKEN"; start: number; end: number }[] = [];
  let start = 0;
  for (let i = 1; i <= phases.length; i++) {
    if (i === phases.length || labelOf(phases[i]!) !== labelOf(phases[start]!)) {
      out.push({
        label: labelOf(phases[start]!),
        start: samples[start]!.ts,
        // 区間 end は実区間の終了（最終サンプル ts + 1サンプル幅・MLR r1 GLM 指摘）:
        // 10秒窓の開始時刻のままだと REM 判定の「>=15分」等が1サンプル分短く評価される
        end: samples[i - 1]!.ts + STEP_MS,
      });
      start = i;
    }
  }
  return out;
}

function isInIntervals(ts: number, intervals: Interval[]): boolean {
  return intervals.some((iv) => ts >= iv.start && ts <= iv.end);
}

export function analyzeSleep(samples: ParsedSample[]): AnalyzeResult {
  if (samples.length === 0) {
    throw new Error("[csvImport] 分析対象のサンプルが空です");
  }

  // 1. 判定パイプライン（real_data.ts 実績経路）
  const classifier = new ActivityClassifier();
  const detector = new SleepPhaseDetector();
  const phases: SleepPhase[] = [];
  for (const { amp } of samples) {
    const flags = classifier.update(amp);
    phases.push(detector.update(flags));
  }

  // 2. 覚醒区間（§3 バッチ版・高活動量+高活動頻度 OR 合成）
  const awakeIntervals = detectAwakeIntervals(samples);

  // 3. REM 区間（§2.5・深眠後処理→REM 生成）
  const processed = postProcessDeepIntervals(
    toHypnogramIntervals(phases, samples),
    CURRENT_VERSION,
    "",
  );
  const remIntervals: Interval[] = detectREM(processed).map((r) => ({
    start: r.start,
    end: r.end,
  }));

  // 4. 統合ラベル（AWAKE > REM > DEEP/LIGHT/BROKEN）
  const stages: SleepStageRow[] = samples.map(({ ts }, i) => {
    let phase: StagePhase;
    if (isInIntervals(ts, awakeIntervals)) {
      phase = "AWAKE";
    } else if (isInIntervals(ts, remIntervals)) {
      phase = "REM";
    } else if (phases[i] === "DEEP_SLEEP") {
      phase = "DEEP";
    } else if (phases[i] === "LIGHT_SLEEP") {
      phase = "LIGHT";
    } else {
      phase = "BROKEN";
    }
    return { tsMs: ts, phase };
  });

  // 5. 比率集計
  const countOf = (p: StagePhase) => stages.filter((s) => s.phase === p).length;
  const total = stages.length;
  const deepRatio = countOf("DEEP") / total;
  const lightRatio = countOf("LIGHT") / total;
  const remRatio = countOf("REM") / total;
  const awakeRatio = countOf("AWAKE") / total;

  // 6. スコア（CSV 算出可能な 3 測定のみ・§4 合否比率）
  const startMs = samples[0]!.ts;
  const endMs = samples[samples.length - 1]!.ts;
  const calc = new SleepScoreCalculator();
  const durationMin = (endMs - startMs) / 60_000;
  calc.updateMeasure("DURATION", durationMin);
  calc.updateMeasure("DEEP_SLEEP", deepRatio);
  calc.updateMeasure("EFFICIENCY", 1 - awakeRatio);

  return {
    startMs,
    endMs,
    sampleCount: total,
    deepRatio,
    lightRatio,
    remRatio,
    awakeRatio,
    score: calc.getScorePercentage(),
    stages,
  };
}
