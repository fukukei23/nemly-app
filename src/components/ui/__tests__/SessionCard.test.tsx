import React from "react";
import { SessionCard } from "../SessionCard";
import { renderUI } from "./renderUI";

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
  it("日付・時間・スコア・ミニヒプノグラムを描画する", async () => {
    const tree = (await renderUI(<SessionCard session={{ ...base }} onPress={jest.fn()} />)).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("score=null のとき -- 表示", async () => {
    const tree = (await renderUI(
      <SessionCard session={{ ...base, score: null, source: "csv" }} onPress={jest.fn()} />,
    )).toJSON();
    expect(tree).toMatchSnapshot();
  });
});
