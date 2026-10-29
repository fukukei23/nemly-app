import React from "react";
import { HypnogramBar } from "../HypnogramBar";
import { renderUI } from "./renderUI";
import type { SleepStageRow } from "@/lib/repository";

function row(phase: "DEEP" | "LIGHT" | "REM" | "AWAKE" | "BROKEN", tsMs: number): SleepStageRow {
  return { tsMs, phase } as SleepStageRow;
}

describe("HypnogramBar", () => {
  it("stage配列をphase色の横バー列で描画する", async () => {
    const stages = [row("DEEP", 1), row("LIGHT", 2), row("REM", 3), row("AWAKE", 4)];
    const tree = (await renderUI(<HypnogramBar stages={stages} height={36} />)).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("空配列でもクラッシュしない", async () => {
    expect(() => renderUI(<HypnogramBar stages={[]} height={36} />)).not.toThrow();
    await renderUI(<HypnogramBar stages={[]} height={36} />);
  });
});
