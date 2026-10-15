import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

// The SVG is the single source for sidebar, browser, and installed app icons.
const svg = await readFile(new URL("../public/icon.svg", import.meta.url), "utf8");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({
  ...(existsSync(chrome) ? { executablePath: chrome } : {}),
  headless: true,
});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [size, name] of [
    [192, "icon-192.png"],
    [512, "icon-512.png"],
    [180, "apple-touch-icon.png"],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`,
    );
    await page.screenshot({
      path: new URL(`../public/${name}`, import.meta.url).pathname,
      omitBackground: true,
    });
  }
} finally {
  await browser.close();
}
