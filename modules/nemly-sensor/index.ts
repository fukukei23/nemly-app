/**
 * NemlySensor ネイティブモジュールの JS ラッパー
 * 遅延 require 前提（jest 環境では native module が解決できないため直接 import しない）
 */
import { requireNativeModule } from 'expo-modules-core';

export interface NemlySensorModuleType {
  /** durationMinutes 指定時はその経過後にネイティブ側で自動停止（機能C・昼寝ショートカット用） */
  startRecording(durationMinutes?: number): string;
  stopRecording(): string;
  pullSeries(sessionId: string): Promise<string>;
  confirmImported(sessionId: string): string;
  getStatus(): string;
  getLastSessionId(): string;
  /** 未取り込み（status='finished'）の最新セッションID・なければ空文字（2026-11-03） */
  getPendingSessionId(): string;
  /** import 排他 lease（設計書 §4+MLR指摘・token 形式・30秒自動期限切れ・不一致解放は無視） */
  acquireLease(): number;
  releaseLease(token: number): boolean;
  isImporting(): boolean;
}

export default requireNativeModule('NemlySensor') as NemlySensorModuleType;
