import React from "react";
import { ResultDialog } from "../ResultDialog";
import { renderUI } from "./renderUI";

describe("ResultDialog", () => {
  it("visible=true のときタイトルとメッセージを深夜パレットのカードで描画する（fail tone）", async () => {
    const renderer = await renderUI(
      <ResultDialog
        visible
        title="計測の判定: fail"
        message="stationary_rate: 100.0% > 90%"
        tone="fail"
        onClose={jest.fn()}
      />,
    );
    expect(renderer.toJSON()).toMatchSnapshot();
  });

  it("tone=ok のときはアクセント色で描画する", async () => {
    const renderer = await renderUI(
      <ResultDialog
        visible
        title="計測を取り込みました"
        message="一覧に表示されています"
        tone="ok"
        onClose={jest.fn()}
      />,
    );
    expect(renderer.toJSON()).toMatchSnapshot();
  });

  it("visible=false のときは何も描画しない", async () => {
    const renderer = await renderUI(
      <ResultDialog
        visible={false}
        title="x"
        message="y"
        tone="ok"
        onClose={jest.fn()}
      />,
    );
    expect(renderer.toJSON()).toBeNull();
  });
});
