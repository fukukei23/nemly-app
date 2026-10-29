import React from "react";
import TestRenderer from "react-test-renderer";

/**
 * react-test-renderer 用の同期レンダリングヘルパー。
 * React 19 の scheduler がテスト終了後に flush して
 * "require after Jest environment has been torn down" を起こすため、
 * act() 内で create を完結させる（全スナップショットテストで使用）。
 */
export async function renderUI<T extends React.ReactElement>(
  element: T,
): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await TestRenderer.act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}
