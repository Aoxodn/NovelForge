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
const output = "test-results/dashboard";
await mkdir(output, { recursive: true });

try {
  for (const [width, height, theme] of [
    [1600, 1000, "light"],
    [1280, 800, "dark"],
    [900, 720, "light"],
    [640, 640, "dark"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `http://127.0.0.1:5173/tests/fixtures/dashboard.html?theme=${theme}`,
    );
    await page.getByRole("heading", { name: /继续写下去/ }).waitFor();
    await page.locator(".book-card").first().waitFor();
    assert.equal(await page.locator(".action-card").count(), 3);
    assert.equal(await page.locator(".book-card").count(), 4);
    const geometry = await page.evaluate(() => ({
      bodyOverflow: document.documentElement.scrollWidth > innerWidth,
      innerWidth: document
        .querySelector(".dashboard-inner")
        ?.getBoundingClientRect().width,
      titleSize: Number.parseFloat(
        getComputedStyle(document.querySelector(".dashboard-hero h1")).fontSize,
      ),
      continueBottom: document
        .querySelector(".dash-continue-action")
        ?.getBoundingClientRect().bottom,
      firstBookTop: document
        .querySelector(".book-card")
        ?.getBoundingClientRect().top,
    }));
    assert.equal(geometry.bodyOverflow, false, `${width}: horizontal overflow`);
    assert(
      geometry.innerWidth > Math.min(500, width * 0.7),
      `${width}: layout too narrow`,
    );
    assert(geometry.titleSize >= 44, `${width}: headline hierarchy lost`);
    assert(
      geometry.continueBottom < height,
      `${width}: continue writing action is below the fold`,
    );
    assert(
      geometry.firstBookTop < height,
      `${width}: recent work is not visible without scrolling`,
    );
    assert.equal(
      await page.getByRole("button", { name: "新建作品", exact: true }).count(),
      0,
      `${width}: duplicate new-project action remains in hero`,
    );
    assert.equal(
      await page.getByRole("button", { name: "导入稿件", exact: true }).count(),
      0,
      `${width}: duplicate import action remains in hero`,
    );
    await page.getByRole("button", { name: /最近创作《长夜听雨》/ }).click();
    await page.waitForFunction(() => window.__openedPath === "fixture/one");
    await page.getByRole("button", { name: /新建小说/ }).click();
    await page.locator(".modal").waitFor();
    await page.locator(".modal").getByRole("button", { name: "关闭" }).click();
    await page.locator(".dashboard-scroll").evaluate((element) => {
      element.style.scrollBehavior = "auto";
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: `${output}/${width}-${height}-${theme}-hero.png`,
    });
    await page.locator(".dashboard-scroll").evaluate((element) => {
      element.style.scrollBehavior = "auto";
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(100);
    await page.screenshot({
      path: `${output}/${width}-${height}-${theme}-shelf.png`,
    });
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `PASS ${width}x${height} ${theme}: hierarchy, actions, modal, shelf, overflow`,
    );
  }
} finally {
  await browser.close();
}
