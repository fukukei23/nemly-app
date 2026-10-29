import React from "react";
import TestRenderer from "react-test-renderer";
import { HypnogramBar } from "../HypnogramBar";
import type { SleepStageRow } from "@/lib/repository";

function row(phase: "DEEP" | "LIGHT" | "REM" | "AWAKE" | "BROKEN", tsMs: number): SleepStageRow {
  return { tsMs, phase } as SleepStageRow;
}

describe("HypnogramBar", () => {
  it("stage配列をphase色の横バー列で描画する", () => {
    const stages = [row("DEEP", 1), row("LIGHT", 2), row("REM", 3), row("AWAKE", 4)];
    const tree = TestRenderer.create(<HypnogramBar stages={stages} height={36} />).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("空配列でもクラッシュしない", () => {
    expect(() => TestRenderer.create(<HypnogramBar stages={[]} height={36} />).toJSON()).not.toThrow();
  });
});
