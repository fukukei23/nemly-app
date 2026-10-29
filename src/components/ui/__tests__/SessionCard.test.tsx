import React from "react";
import TestRenderer from "react-test-renderer";
import { SessionCard } from "../SessionCard";

const base = {
  id: 1,
  startMs: 1_792_867_680_000,
  endMs: 1_792_895_480_000,
  sampleCount: 1342,
  deepRatio: 0.22,
  lightRatio: 0.64,
  remRatio: 0.13,
  awakeRatio: 0.01,
  score: 67,
  source: "sensor",
  createdAt: "2026-10-29T23:40:00.000Z",
};

describe("SessionCard", () => {
  it("日付・時間・スコア・ミニヒプノグラムを描画する", () => {
    const tree = TestRenderer.create(<SessionCard session={{ ...base }} onPress={jest.fn()} />).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("score=null のとき -- 表示", () => {
    const tree = TestRenderer.create(
      <SessionCard session={{ ...base, score: null, source: "csv" }} onPress={jest.fn()} />,
    ).toJSON();
    expect(tree).toMatchSnapshot();
  });
});
