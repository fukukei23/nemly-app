import React from "react";
import { ScoreGauge } from "../ScoreGauge";
import { renderUI } from "./renderUI";

describe("ScoreGauge", () => {
  it("スコア数字とゴールド輪の円形を描画する", async () => {
    const tree = (await renderUI(<ScoreGauge score={67} />)).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("score=null のとき -- を表示する", async () => {
    const tree = (await renderUI(<ScoreGauge score={null} />)).toJSON();
    expect(tree).toMatchSnapshot();
  });
});
