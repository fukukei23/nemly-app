import React from "react";
import { MetricGauge } from "../MetricGauge";
import { renderUI } from "./renderUI";

describe("MetricGauge", () => {
  it("値とラベルの小円を描画する", async () => {
    const tree = (await renderUI(<MetricGauge value="3:39" label="睡眠時間" />)).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("欠損値（--）も描画できる", async () => {
    const tree = (await renderUI(<MetricGauge value="--" label="効率" />)).toJSON();
    expect(tree).toMatchSnapshot();
  });
});
