/**
 * NemlySensor ネイティブモジュールの JS ラッパー
 * 遅延 require 前提（jest 環境では native module が解決できないため直接 import しない）
 */
import { requireNativeModule } from 'expo-modules-core';

type NemlySensorModuleType = {
  startRecording(): string;
  stopRecording(): string;
  pullSeries(sessionId: string): Promise<string>;
  confirmImported(sessionId: string): string;
  getStatus(): string;
  getLastSessionId(): string;
};

declare const requireNativeModule: (name: string) => NemlySensorModuleType;

export default requireNativeModule('NemlySensor') as NemlySensorModuleType;
