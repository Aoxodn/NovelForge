// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  calculateVolumeDropIndex,
  isTreeActivationKey,
} from "../components/ChapterTree";

describe("卷拖拽目标索引", () => {
  // [A, B, C, D]：后端会先移除源卷，再按返回索引插入。
  it.each([
    ["A → B 前", 0, 1, "before", 0],
    ["A → B 后", 0, 1, "after", 1],
    ["B → A 前", 1, 0, "before", 0],
    ["B → A 后", 1, 0, "after", 1],
    ["A → D 前", 0, 3, "before", 2],
    ["A → D 后", 0, 3, "after", 3],
    ["D → A 前", 3, 0, "before", 0],
    ["D → A 后", 3, 0, "after", 1],
  ])(
    "%s 计算源移除后的插入位置",
    (_name, source, target, position, expected) => {
      expect(
        calculateVolumeDropIndex(
          source as number,
          target as number,
          position as "before" | "after",
          4,
        ),
      ).toBe(expected);
    },
  );
});

describe("目录树键盘激活", () => {
  it.each(["Enter", " "])("%s 激活卷折叠和章节选择", (key) =>
    expect(isTreeActivationKey(key)).toBe(true),
  );

  it.each(["Tab", "Escape", "ArrowDown"])("%s 不会误触发目录操作", (key) =>
    expect(isTreeActivationKey(key)).toBe(false),
  );
});
