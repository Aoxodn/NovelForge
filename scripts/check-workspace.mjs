import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const { chromium } = await import(
  process.env.NOVELFORGE_PLAYWRIGHT_PATH
    ? pathToFileURL(process.env.NOVELFORGE_PLAYWRIGHT_PATH).href
    : "playwright"
);
const browser = await chromium.launch({
  headless: true,
  channel: process.env.NOVELFORGE_BROWSER_CHANNEL || undefined,
});
const output = "test-results/workspace";
await mkdir(output, { recursive: true });

try {
  for (const [width, height, theme, mode] of [
    [1600, 1000, "light", "empty"],
    [1600, 1000, "sepia", "filled"],
    [1280, 800, "dark", "filled"],
    [1024, 720, "light", "empty"],
    // 960x600 is the common 150%/175% effective viewport for a 1440/1680px display.
    [960, 600, "sepia", "filled"],
    [640, 420, "dark", "empty"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `http://127.0.0.1:5173/tests/fixtures/workspace.html?theme=${theme}&mode=${mode}`,
    );
    await page.getByRole("navigation", { name: "项目视图" }).waitFor();
    const more = page.getByRole("button", { name: "更多工具" });
    assert.notEqual(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
      "更多工具",
      `${width}: toolbar stole initial focus`,
    );
    await more.click();
    await page.locator(".toolbar-popover").waitFor();
    assert.equal(
      await more.getAttribute("aria-haspopup"),
      "menu",
      `${width}: menu semantics`,
    );
    assert.equal(
      await more.getAttribute("aria-expanded"),
      "true",
      `${width}: menu opened`,
    );
    const menuItems = page.locator(
      '.toolbar-popover button[role="menuitem"]:not(:disabled)',
    );
    assert(
      (await menuItems.count()) > 0,
      `${width}: menu has no reachable items`,
    );
    const lastMenuItem = menuItems.last();
    await lastMenuItem.scrollIntoViewIfNeeded();
    assert(
      await lastMenuItem.isVisible(),
      `${width}: last menu item is not reachable`,
    );
    const menuGeometry = await page
      .locator(".toolbar-popover")
      .evaluate((el) => ({
        scrollable: el.scrollHeight > el.clientHeight,
        bounded: el.getBoundingClientRect().bottom <= innerHeight,
      }));
    assert(menuGeometry.bounded, `${width}: tools popover clipped by viewport`);
    await page.keyboard.press("Escape");
    await page.locator(".toolbar-popover").waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
      "更多工具",
      `${width}: menu focus not restored`,
    );

    // Focus mode must be represented by the actual shell class and close with Esc.
    const focusButton = page.getByRole("button", { name: "专注模式" });
    await focusButton.click();
    await page.locator('[data-testid="fixture-main-columns"].focus').waitFor();
    await page.keyboard.press("Escape");
    await page
      .locator('[data-testid="fixture-main-columns"]:not(.focus)')
      .waitFor();

    // View switching is also driven through the fixture shell, not a test-only stub.
    await page.getByRole("button", { name: "图谱" }).click();
    await page
      .locator('[data-testid="fixture-main-columns"].view-switched')
      .waitFor({ state: "attached" });
    await page.locator('[data-testid="fixture-story-view"]').waitFor();
    await page.getByRole("button", { name: "写作", exact: true }).click();
    await page
      .locator('[data-testid="fixture-main-columns"]:not(.view-switched)')
      .waitFor();

    // Theme cycling must update the store-backed document theme.
    await more.click();
    const beforeTheme = await page.locator("html").getAttribute("data-theme");
    await page.getByRole("menuitem", { name: /主题：/ }).click();
    const afterTheme = await page.locator("html").getAttribute("data-theme");
    assert.notEqual(afterTheme, beforeTheme, `${width}: theme did not cycle`);
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
      "更多工具",
      `${width}: menu action did not restore trigger focus`,
    );

    const geometry = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      topbarBottom: document.querySelector(".topbar").getBoundingClientRect()
        .bottom,
      statusBottom: document.querySelector(".statusbar").getBoundingClientRect()
        .bottom,
      editorWidth: document.querySelector(".editor").getBoundingClientRect()
        .width,
      sidebarWidth: document.querySelector(".sidebar").getBoundingClientRect()
        .width,
      infoWidth: document.querySelector(".info-panel").getBoundingClientRect()
        .width,
    }));
    assert.equal(
      geometry.horizontalOverflow,
      false,
      `${width}: horizontal overflow`,
    );
    assert.equal(geometry.topbarBottom, 56, `${width}: toolbar geometry`);
    assert(geometry.statusBottom <= height, `${width}: status bar clipped`);
    if (width >= 769) {
      assert(geometry.editorWidth > 400, `${width}: writing area too narrow`);
      assert(geometry.sidebarWidth >= 190, `${width}: chapter list unusable`);
      assert(geometry.infoWidth >= 240, `${width}: inspector unusable`);
    } else {
      assert.equal(
        geometry.sidebarWidth,
        0,
        `${width}: sidebar should collapse`,
      );
      assert.equal(
        geometry.infoWidth,
        0,
        `${width}: inspector should collapse`,
      );
      assert(
        geometry.editorWidth > width * 0.8,
        `${width}: writing area too narrow`,
      );
    }
    if (mode === "empty") {
      await page.getByRole("button", { name: /创建第一章/ }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      assert.equal(
        await dialog.getAttribute("aria-modal"),
        "true",
        `${width}: modal semantics`,
      );
      const labelledBy = await dialog.getAttribute("aria-labelledby");
      const titleLinked = await page.evaluate(
        (id) => Boolean(id && document.getElementById(id)),
        labelledBy,
      );
      assert(labelledBy && titleLinked, `${width}: modal title not associated`);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.textContent?.includes("创建第一章"),
        ),
        true,
        `${width}: modal focus not restored`,
      );
    } else {
      await page.getByRole("textbox", { name: "章节标题" }).waitFor();
      assert.equal(await page.locator(".chapter-row.active").count(), 1);
    }
    await page.screenshot({
      path: `${output}/${width}-${height}-${theme}-${mode}.png`,
    });
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}x${height} ${theme} ${mode}: layout, navigation, tools, editor`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
