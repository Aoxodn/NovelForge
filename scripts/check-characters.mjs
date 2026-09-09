// Run Vite first. Uses Playwright, optionally supplied by the local workspace runtime.
// NOVELFORGE_PLAYWRIGHT_PATH=/absolute/path/to/playwright/index.mjs node scripts/check-characters.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(
  process.env.NOVELFORGE_PLAYWRIGHT_PATH
    ? pathToFileURL(process.env.NOVELFORGE_PLAYWRIGHT_PATH).href
    : 'playwright'
);
const browser = await chromium.launch({
  headless: true,
  channel: process.env.NOVELFORGE_BROWSER_CHANNEL || undefined,
});
const output = 'test-results/characters';
await mkdir(output, { recursive: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  for (const [width, height, theme] of [
    [1600, 1000, 'sepia'],
    [1280, 720, 'light'],
    [1024, 640, 'dark'],
    [800, 600, 'sepia'],
    [640, 480, 'light'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(
      `http://127.0.0.1:5173/tests/fixtures/characters.html?theme=${theme}`,
    );
    await page.addStyleTag({
      content:
        '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });
    await page
      .getByRole('textbox', { name: '角色姓名', exact: true })
      .waitFor();
    await page
      .getByRole('textbox', { name: '角色姓名', exact: true })
      .inputValue()
      .then((v) => assert.equal(v, '沈照夜'));
    const layout = await page.evaluate(() => {
      const scroll = document.querySelector('.char-editor-scroll');
      const notes = document.querySelector('.char-notes-textarea');
      const actions = document.querySelector('.char-actions');
      return {
        scrollable: scroll.scrollHeight > scroll.clientHeight,
        notesHeight: notes.getBoundingClientRect().height,
        actionsBottom: actions.getBoundingClientRect().bottom,
        horizontalOverflow: scroll.scrollWidth > scroll.clientWidth,
      };
    });
    assert(layout.scrollable, `${width}: detail must scroll`);
    assert(layout.notesHeight >= 300, `${width}: notes must not collapse`);
    assert(layout.actionsBottom < height, `${width}: footer must be visible`);
    assert(!layout.horizontalOverflow, `${width}: no horizontal overflow`);
    await page
      .getByRole('button', { name: '删除角色', exact: true })
      .click({ trial: true });
    await page.locator('.char-editor-scroll').hover();
    await page.mouse.wheel(0, 2000);
    await page.waitForFunction(
      () => document.querySelector('.char-editor-scroll').scrollTop > 0,
    );
    await page.getByRole('button', { name: '+ 添加', exact: true }).click();
    await page
      .getByRole('textbox', { name: '自定义字段 1 名称' })
      .fill('口头禅');
    await page
      .getByRole('textbox', { name: '自定义字段 1 内容' })
      .fill('天亮前，总能找到路。');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page
      .locator('.char-save-state')
      .filter({ hasText: '已保存' })
      .waitFor();
    await page.locator('.char-editor-scroll').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({
      path: `${output}/${width}-${height}-${theme}-profile.png`,
    });
    await page.getByRole('button', { name: '出场与关系', exact: true }).click();
    await page.getByLabel('关联角色', { exact: true }).selectOption('2');
    await page.getByRole('button', { name: '建立关系', exact: false }).click();
    await page.locator('.rel-list').waitFor();
    await page.screenshot({
      path: `${output}/${width}-${height}-${theme}-story.png`,
    });
    // Virtual list continues rendering after a long scroll and after filtering.
    await page.locator('.char-list').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page
      .getByRole('textbox', { name: '搜索角色', exact: true })
      .fill('温知微');
    await page.locator('.char-list-item').filter({ hasText: '温知微' }).click();
    assert.equal(
      await page.getByLabel('关联角色', { exact: true }).inputValue(),
      '',
    );
    await page.getByRole('button', { name: '主角', exact: true }).click();
    for (let i = 0; i < 3; i++) {
      await page
        .getByRole('button', { name: '+ 新建角色', exact: true })
        .click();
      await page.waitForFunction(
        (expected) =>
          document.querySelector('.char-name-input')?.value === expected,
        i === 0 ? '新角色' : `新角色 ${i + 1}`,
      );
    }
    assert.equal(
      await page
        .getByRole('textbox', { name: '搜索角色', exact: true })
        .inputValue(),
      '',
    );
    console.log(
      `PASS ${width}x${height} ${theme}: scroll, layout, footer, relations, virtual list, 3 creates`,
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
