import React from "react";
import TestRenderer from "react-test-renderer";
import { ScoreGauge } from "../ScoreGauge";

describe("ScoreGauge", () => {
  it("スコア数字とゴールド輪の円形を描画する", () => {
    const tree = TestRenderer.create(<ScoreGauge score={67} />).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("score=null のとき -- を表示する", () => {
    const tree = TestRenderer.create(<ScoreGauge score={null} />).toJSON();
    expect(tree).toMatchSnapshot();
  });
});
