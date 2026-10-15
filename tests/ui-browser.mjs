import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { renderConsentPage } from "../worker/consent-page.ts";
import { consentRedirectPolicy } from "../worker/consent-policy.ts";

async function assertMobileInputSizes(page) {
  const small = await page
    .locator('input, textarea, select, [contenteditable="true"]')
    .evaluateAll((elements) =>
      elements
        .filter(
          (element) =>
            element.getClientRects().length > 0 &&
            !["checkbox", "radio", "file", "hidden"].includes(element.type),
        )
        .filter((element) => parseFloat(getComputedStyle(element).fontSize) < 16)
        .map((element) => ({
          label: element.getAttribute("aria-label") || element.className,
          size: getComputedStyle(element).fontSize,
        })),
    );
  assert.deepEqual(small, [], "all visible mobile form controls are at least 16px");
}
async function reloadBoard(page) {
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/tasks",
  );
  await page.reload();
  await (await response).finished();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
async function mobileNavigate(page, name) {
  await page.locator(".mobile-menu-toggle").click();
  await page.locator("#mobile-navigation").getByRole("button", { name, exact: true }).click();
  await page.locator(".mobile-menu").waitFor({ state: "hidden" });
}
async function showPanel(page, status) {
  await page.locator(`.column[data-drop-status="${status}"]`).evaluate((panel) => {
    const surface = panel.closest(".board-scroll");
    surface.scrollTo({
      left:
        surface.scrollLeft +
        panel.getBoundingClientRect().left -
        surface.getBoundingClientRect().left,
      behavior: "instant",
    });
  });
}
const source = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
const csp = consentRedirectPolicy("https://chatgpt.com/connector_platform_oauth_redirect");
const boardCsp = source.match(/headers\.set\(\s*["']content-security-policy["'],\s*"([^"]+)"/)[1];
let config = { services: [], targets: [], agents: [], models: [], rules: [] };
let version = 1;
let lastConsent;
let connections = [
  {
    id: "test-connection",
    client_id: "test-client",
    client_name: "ChatGPT",
    scopes: ["tasks:read", "tasks:write"],
    created_at: 1700000000,
  },
];
let defaultConnectionId = "test-connection";
let connectionVersion = 1;
const tasks = [];
let uploadedBytes;
let revisionSignature = "";
let boardRevision = 1;
let revisionReads = 0;
let boardReads = 0;
let failBoardRead = false;
let holdBoardReads = false;
const heldBoardReads = [];

let lastArchive;
let rejectProjectChange = false;
let rejectIconSave = false;
let lastProjectPatch;
const taskEvents = [
  {
    id: "routing",
    kind: "routing",
    body: "一致ルールはありません。自動実行は始まりません。",
    created_at: new Date().toISOString(),
  },
  { id: "updated", kind: "updated", body: "タスクを編集", created_at: new Date().toISOString() },
  {
    id: "progress",
    kind: "progress",
    body: "調査が完了しました。",
    created_at: new Date().toISOString(),
    result_url: "https://example.test/result",
  },
];
taskEvents.unshift({
  id: "older-progress",
  kind: "progress",
  body: "調査を開始しました。",
  created_at: "2026-01-01T00:00:00.000Z",
});
const manifestRequests = [];
const uploadedPath = "/api/service-icons/11111111-1111-4111-8111-111111111111";
const taskImageUploads = new Map();
const icon = "https://icons.example.test/favicon.svg";
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const json = (value, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (url.pathname === "/consent") {
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      lastConsent = new URLSearchParams(body);
      return json({ ok: true });
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
    });
    return response.end(
      renderConsentPage(
        {
          clientName: url.searchParams.has("hostile") ? "<img src=x onerror=alert(1)>" : "ChatGPT",
          clientDomain: "chatgpt.com",
          redirectHost: "chatgpt.com",
          redirectIsLoopback: false,
          scope: ["tasks:read", "tasks:write", "offline_access"],
        },
        "test-handle",
      ),
    );
  }
  if (url.pathname === "/api/board/revision") {
    revisionReads++;
    const signature = JSON.stringify({ tasks, config, connections });
    if (signature !== revisionSignature) {
      revisionSignature = signature;
      boardRevision++;
    }
    const etag = `"board-${boardRevision}"`;
    response.setHeader("etag", etag);
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304);
      return response.end();
    }
    return json({ revision: boardRevision });
  }
  if (url.pathname === "/api/settings") {
    if (request.method === "PUT") {
      if (rejectIconSave) return json({ code: "server_error" }, 500);
      if (request.headers["if-match"] !== String(version))
        return json({ code: "settings_conflict" }, 409);
      let body = "";
      for await (const chunk of request) body += chunk;
      config = JSON.parse(body);
      version++;
    }
    return json({ config, version, history: [] });
  }
  if (url.pathname === "/api/routing") return json({ config });
  if (url.pathname === "/api/tasks") {
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const task = {
        ...JSON.parse(body),
        id: "22222222-2222-4222-8222-222222222222",
        dispatch: "draft",
        version: 1,
        archived_at: null,
        created_at: new Date().toISOString(),
        status_changed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      tasks.push(task);
      return json({ task }, 201);
    }
    boardReads++;
    if (failBoardRead) return json({ error: "Test refresh failure" }, 503);
    const snapshot = JSON.parse(
      JSON.stringify({
        tasks: tasks.filter((task) =>
          url.searchParams.has("archived") ? task.archived_at : !task.archived_at,
        ),
        archived_count: tasks.filter((task) => task.archived_at).length,
        order_versions: {},
      }),
    );
    if (holdBoardReads) {
      heldBoardReads.push(() => json(snapshot));
      return;
    }
    return json(snapshot);
  }
  if (url.pathname === "/api/tasks/archive") {
    let body = "";
    for await (const chunk of request) body += chunk;
    lastArchive = JSON.parse(body);
    for (const task of tasks)
      if (
        task.status === "done" &&
        !task.archived_at &&
        (lastArchive.all || lastArchive.tasks.some((item) => item.id === task.id))
      )
        task.archived_at = new Date().toISOString();
    return json({ ok: true });
  }
  if (url.pathname.startsWith("/api/tasks/")) {
    const task = tasks.find((task) => task.id === url.pathname.split("/")[3]);
    if (!task) return json({ error: "not found" }, 404);
    if (request.method === "PATCH") {
      let body = "";
      for await (const chunk of request) body += chunk;
      lastProjectPatch = JSON.parse(body);
      if (rejectProjectChange || request.headers["if-match"] !== String(task.version))
        return json({ code: "server_error" }, 409);
      Object.assign(task, lastProjectPatch, { version: task.version + 1 });
    }
    return json({ task, events: taskEvents });
  }
  if (url.pathname === "/api/services" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const service = JSON.parse(body);
    config.services.push(service);
    version++;
    return json({ service, config, version }, 201);
  }
  if (url.pathname === "/api/service-icons" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    uploadedBytes = Buffer.concat(chunks);
    return json({ icon: uploadedPath }, 201);
  }
  if (url.pathname === "/api/task-images" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const path = `/api/task-images/${crypto.randomUUID()}`;
    taskImageUploads.set(path, Buffer.concat(chunks));
    return json({ url: path }, 201);
  }
  if (taskImageUploads.has(url.pathname)) {
    response
      .writeHead(200, { "content-type": "image/png" })
      .end(taskImageUploads.get(url.pathname));
    return;
  }
  if (url.pathname === uploadedPath) {
    response.writeHead(200, { "content-type": "image/png" }).end(uploadedBytes);
    return;
  }
  if (url.pathname === "/api/connections")
    return json({
      connections,
      default_connection_id: defaultConnectionId,
      version: connectionVersion,
    });
  if (url.pathname === "/api/connections/default" && request.method === "PUT") {
    let body = "";
    for await (const chunk of request) body += chunk;
    defaultConnectionId = JSON.parse(body).connection_id;
    connectionVersion++;
    return json({
      connections,
      default_connection_id: defaultConnectionId,
      version: connectionVersion,
    });
  }
  if (url.pathname === "/api/connections/test-connection" && request.method === "DELETE") {
    connections = connections.filter((item) => item.id !== "test-connection");
    defaultConnectionId = connections[0]?.id ?? null;
    return json({ ok: true });
  }
  if (url.pathname === "/manifest.webmanifest") {
    manifestRequests.push(Boolean(request.headers.cookie?.includes("pwa-session=valid")));
    if (!manifestRequests.at(-1)) {
      response.writeHead(401).end("Login required");
      return;
    }
  }
  if (url.pathname === "/without-manifest-credentials") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      readFileSync(new URL("../dist/index.html", import.meta.url), "utf8").replace(
        'crossorigin="use-credentials"',
        "",
      ),
    );
    return;
  }
  const path =
    url.pathname === "/" ||
    ["/settings", "/projects", "/connections"].includes(url.pathname) ||
    /^\/tasks\/(?:new|[0-9a-f-]{36})$/.test(url.pathname)
      ? "index.html"
      : url.pathname.slice(1);
  if (!/^(index\.html|sw\.js|manifest\.webmanifest|icon[\w.-]*|assets\/[\w.-]+)$/.test(path)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const contentType = path.endsWith(".webmanifest")
      ? "application/manifest+json"
      : path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".svg")
            ? "image/svg+xml"
            : path.endsWith(".png")
              ? "image/png"
              : "text/html; charset=utf-8";
    response.writeHead(200, { "content-type": contentType, "content-security-policy": boardCsp });
    response.end(readFileSync(new URL("../dist/" + path, import.meta.url)));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const screenshots = join(tmpdir(), "dot-kanban-ui");
mkdirSync(screenshots, { recursive: true });
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let browser;
try {
  browser = await chromium.launch({
    ...(existsSync(chrome) ? { executablePath: chrome } : {}),
    headless: true,
  });
  console.log("START browser UI checks");
  const context = await browser.newContext({ locale: "ja-JP", serviceWorkers: "allow" });
  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(15_000);
  await context.route("https://icons.example.test/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="8" fill="#143c31"/><circle cx="20" cy="20" r="9" fill="#d6f788"/></svg>',
    }),
  );
  await context.addCookies([{ name: "pwa-session", value: "valid", url: base }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(base + "/consent");
  console.log("PASS consent page loaded");
  await page.screenshot({ path: join(screenshots, "consent-desktop.png"), fullPage: true });
  assert.equal(await page.locator("input[name=scope]").count(), 3);
  await page.locator('input[value="tasks:write"]').uncheck();
  await page.locator('input[value="offline_access"]').uncheck();
  await page.getByRole("button", { name: "接続を許可する" }).click();
  await page.waitForFunction(() => document.body.textContent.includes('"ok"'));
  assert.deepEqual(lastConsent.getAll("scope"), ["tasks:read"]);
  assert.equal(lastConsent.get("handle"), "test-handle");
  assert.equal(lastConsent.get("decision"), "approve");
  await page.goto(base + "/consent");
  await page.locator('input[value="tasks:read"]').uncheck();
  await page.getByRole("button", { name: "キャンセル" }).click();
  await page.waitForFunction(() => document.body.textContent.includes('"ok"'));
  assert.equal(lastConsent.get("decision"), "deny", "cancel works without required scope");
  await page.goto(base + "/consent?hostile=1");
  assert.equal(await page.locator("img").count(), 0, "client names are escaped");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(base + "/consent");
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "consent has no horizontal overflow",
    );
    if (width === 390)
      await page.screenshot({ path: join(screenshots, "consent-mobile.png"), fullPage: true });
  }
  console.log("PASS consent UI checks");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(base);
  assert.equal(
    await page.getByRole("button", { name: "更新", exact: true }).count(),
    0,
    "manual refresh button is removed",
  );
  const menuToggle = page.locator(".rail-toggle");
  assert.equal(
    await menuToggle.getAttribute("aria-expanded"),
    "false",
    "side menu starts collapsed",
  );
  assert.equal((await page.locator(".rail").boundingBox()).width, 64);
  await menuToggle.click();
  assert.equal(await menuToggle.getAttribute("aria-expanded"), "true");
  assert.equal((await page.locator(".rail").boundingBox()).width, 228);
  await menuToggle.click();
  assert.equal(await menuToggle.getAttribute("aria-expanded"), "false");

  await page.evaluate(() => {
    window.navigationMarker = "same-document";
  });
  await page.locator(".rail").getByRole("button", { name: "設定" }).click();
  await page.getByRole("heading", { name: "設定", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Author", exact: true }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "のっち", exact: true }).count(), 1);
  assert.equal(
    await page.getByRole("link", { name: "のっち", exact: true }).getAttribute("href"),
    "https://mi-te.me/sano",
  );
  assert.equal(
    await page.getByRole("link", { name: "のっち", exact: true }).getAttribute("target"),
    "_blank",
  );
  assert.equal(
    await page.getByRole("link", { name: "のっち", exact: true }).locator("svg").count(),
    1,
  );
  assert.equal(
    await page
      .getByRole("link", { name: "https://github.com/nocico-nocio/dot-kanban", exact: true })
      .getAttribute("href"),
    "https://github.com/nocico-nocio/dot-kanban",
  );
  assert.equal(
    await page.getByRole("link", { name: "不具合・改善の提案", exact: true }).getAttribute("href"),
    "https://github.com/nocico-nocio/dot-kanban/issues",
  );
  await page.waitForFunction(() => document.querySelector(".author-avatar")?.naturalWidth > 0);
  assert.equal(
    await page.getByRole("button", { name: "保存", exact: true }).count(),
    0,
    "settings needs no save button",
  );
  assert.equal(
    await page.locator(".service-settings,.mcp-settings").count(),
    0,
    "projects and MCP are separate pages",
  );
  await page.screenshot({ path: join(screenshots, "settings-author-desktop.png"), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "new mobile navigation and Author page fit",
    );
    await assertMobileInputSizes(page);
    if (width === 390)
      await page.screenshot({
        path: join(screenshots, "settings-author-mobile.png"),
        fullPage: true,
      });
  }
  await mobileNavigate(page, "プロジェクト一覧");
  await page.getByRole("heading", { name: "プロジェクト一覧", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/projects");
  await mobileNavigate(page, "MCP接続");
  await page.getByRole("heading", { name: "MCP接続", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/connections");
  await page.goBack();
  await page.getByRole("heading", { name: "プロジェクト一覧", exact: true }).waitFor();
  await page.goForward();
  await page.getByRole("heading", { name: "MCP接続", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.navigationMarker),
    "same-document",
    "sidebar/mobile navigation preserves the document",
  );
  await page.reload();
  await page.getByRole("heading", { name: "MCP接続", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/connections", "MCP page survives reload");
  assert.equal(
    await page.getByRole("button", { name: "保存", exact: true }).count(),
    0,
    "MCP actions save immediately",
  );
  await page.setViewportSize({ width: 1440, height: 1100 });

  assert.equal(await page.getByLabel("MCP接続URL", { exact: true }).inputValue(), base + "/mcp");
  const guide = page.locator(".mcp-setup");
  assert.equal(await guide.getByRole("tab").count(), 6);
  assert.ok(
    (await guide.boundingBox()).y > (await page.locator(".mcp-connections").boundingBox()).y,
    "setup appears below connected agents",
  );
  assert.equal(
    await page
      .getByText(
        "このURLを実行側のアプリに登録して接続します。タスクの実行とモデル選択は、接続先のアプリが担当します。",
        { exact: true },
      )
      .count(),
    0,
  );
  for (const name of ["ChatGPT", "Claude", "Grok", "Codex", "Gemini CLI", "Cursor"]) {
    await guide.getByRole("tab", { name, exact: true }).click();
    assert.equal(
      await guide.getByRole("tab", { name, exact: true }).getAttribute("aria-selected"),
      "true",
    );
    const prompt = await guide.locator("textarea").inputValue();
    assert.ok(
      prompt.includes(name) &&
        prompt.includes(base + "/mcp") &&
        prompt.includes("着手前に登録") &&
        prompt.includes("INSTALL.ja.md") &&
        prompt.includes("https://github.com/nocico-nocio/dot-kanban"),
    );
    assert.ok(prompt.length < 450, "registration prompt stays short");
    assert.ok(
      !prompt.includes("claim_id") && !prompt.includes("approval_confirmed"),
      "operational detail lives in INSTALL",
    );
    assert.ok((await guide.getByRole("link").first().getAttribute("href")).startsWith("https://"));
    const notes = await guide.locator(".mcp-execution").innerText();
    const notice = guide.locator(".mcp-client-note");
    if (name === "ChatGPT") {
      assert.ok((await notice.innerText()).includes("端末"));
      assert.equal(await guide.locator(".mcp-recommended").innerText(), "おすすめ");
    } else if (name === "Claude") {
      assert.equal((await notice.innerText()).trim(), "");
    } else {
      assert.ok((await notice.innerText()).includes("開発者未確認"));
      assert.equal(
        await notice.getByRole("link").getAttribute("href"),
        "https://github.com/nocico-nocio/dot-kanban/issues/new",
      );
    }
    const expected = {
      ChatGPT: ["ChatGPTデスクトップ", "10分以上"],
      Claude: ["/loop", "/schedule", "最短1時間"],
      Grok: ["利用可否", "未設定"],
      Codex: ["CLI", "環境名"],
      "Gemini CLI": ["OAuth", "cron"],
      Cursor: ["Automations", "OS"],
    }[name];
    for (const text of expected)
      assert.ok(notes.includes(text), `${name} shows its execution requirements`);
    const place = guide.getByRole("combobox", { name: "実行場所", exact: true });
    if (name === "Gemini CLI") assert.equal(await place.inputValue(), "local");
    await place.selectOption("cloud");
    assert.ok((await guide.locator("textarea").inputValue()).includes("作業はクラウドで行いたい"));
    await place.selectOption("local");
    assert.ok((await guide.locator("textarea").inputValue()).includes("作業は私の端末で行いたい"));
  }
  await guide.getByRole("tab", { name: "Cursor", exact: true }).press("Home");
  assert.equal(
    await guide.getByRole("tab", { name: "ChatGPT", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  await guide.getByRole("tab", { name: "ChatGPT", exact: true }).press("ArrowRight");
  assert.equal(
    await guide.getByRole("tab", { name: "Claude", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (value) => {
        window.copiedSetupText = value;
      },
    });
  });
  await guide.getByRole("button", { name: "指示文をコピー", exact: true }).click();
  await page.waitForFunction(() => window.copiedSetupText?.includes("Claude"));
  assert.equal(
    await page.evaluate(() => window.copiedSetupText),
    await guide.locator("textarea").inputValue(),
  );
  await guide.getByRole("button", { name: "コピー", exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedSetupText), base + "/mcp");
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async () => {
        throw new Error("clipboard unavailable");
      },
    });
  });
  await guide.getByRole("button", { name: "指示文をコピー", exact: true }).click();
  assert.ok(
    await guide
      .locator("textarea")
      .evaluate((input) => input.selectionEnd - input.selectionStart === input.value.length),
    "copy failure selects all instructions",
  );
  await guide.getByRole("tab", { name: "ChatGPT", exact: true }).click();
  await guide.screenshot({ path: join(screenshots, "mcp-setup-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await guide.getByRole("tab", { name: "Cursor", exact: true }).click();
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "setup tabs scroll without overflowing the page",
  );
  await assertMobileInputSizes(page);
  await guide.screenshot({ path: join(screenshots, "mcp-setup-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 1000 });

  for (const label of [
    "実行先",
    "エージェントと CLI アダプタ",
    "許可モデル",
    "振り分けルール",
    "割り当てプレビュー",
    "設定変更履歴",
  ])
    assert.equal(
      await page.getByRole("heading", { name: label, exact: true }).count(),
      0,
      "obsolete execution settings are absent",
    );
  await page.locator(".mcp-connections").getByText("ChatGPT", { exact: true }).waitFor();
  await page
    .locator(".rail")
    .getByRole("button", { name: "プロジェクト一覧", exact: true })
    .click();
  await page.getByRole("button", { name: "プロジェクトを追加" }).click();
  const registration = page.locator(".project-registration");
  await registration.getByLabel("プロジェクト名", { exact: false }).fill("dot kanban");
  await page.setViewportSize({ width: 390, height: 844 });
  await assertMobileInputSizes(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await registration.getByRole("button", { name: "アイコンを選択", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "アイコンを選択", exact: true });
  await picker.getByRole("button", { name: "ロケット", exact: true }).click();
  await picker.getByRole("button", { name: "適用", exact: true }).click();
  rejectIconSave = true;
  await registration.getByRole("button", { name: "プロジェクトを登録" }).click();
  await registration.getByRole("alert").waitFor();
  assert.equal(config.services.length, 0, "failed registration is not shown as saved");
  assert.equal(
    await registration.getByLabel("プロジェクト名", { exact: false }).inputValue(),
    "dot kanban",
  );
  rejectIconSave = false;
  await registration.getByRole("button", { name: "プロジェクトを登録" }).click();
  await registration.waitFor({ state: "detached" });
  await page.reload();
  await page.locator(".project-list-row").waitFor();
  assert.equal(config.services[0].name, "dot kanban");
  assert.equal(config.services[0].icon, "symbol:rocket");
  await page.getByRole("heading", { name: /プロジェクト一覧/ }).waitFor();
  assert.equal(await page.locator(".project-list-row").count(), 1);
  assert.equal(
    await page.locator(".service-settings .project-icon-picker").count(),
    0,
    "preset instructions stay inside the modal",
  );
  for (const name of ["Order B", "Order C"]) {
    await page.getByRole("button", { name: "プロジェクトを追加" }).click();
    await registration.getByLabel("プロジェクト名", { exact: false }).fill(name);
    await registration.getByRole("button", { name: "プロジェクトを登録" }).click();
    await registration.waitFor({ state: "detached" });
  }
  await page.getByRole("button", { name: "Order C: タスクの操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "上へ移動", exact: true }).click();
  await page.getByText("保存しました", { exact: true }).waitFor();
  assert.deepEqual(
    config.services.map((item) => item.name),
    ["dot kanban", "Order C", "Order B"],
  );
  await page
    .getByRole("button", { name: "Order B: 並び替え（ドラッグまたは上下キー）", exact: true })
    .dragTo(page.locator(".project-list-row").first());
  await page.getByText("保存しました", { exact: true }).waitFor();
  await page.reload();
  await page.locator(".project-list-row").first().waitFor();
  assert.deepEqual(
    await page
      .getByLabel("プロジェクト名", { exact: true })
      .evaluateAll((inputs) => inputs.map((input) => input.value)),
    ["Order B", "dot kanban", "Order C"],
  );
  await page.locator(".rail").getByRole("button", { name: "ボード", exact: true }).click();
  await page.getByRole("button", { name: "新しいタスク" }).click();
  await page.getByRole("combobox", { name: "対象プロジェクト", exact: true }).focus();
  assert.deepEqual(await page.locator(".project-suggestions [role=option]").allTextContents(), [
    "Order B",
    "dot kanban",
    "Order C",
  ]);
  await page.locator(".drawer").getByRole("button", { name: "閉じる", exact: true }).click();
  await page
    .locator(".rail")
    .getByRole("button", { name: "プロジェクト一覧", exact: true })
    .click();
  for (const name of ["Order B", "Order C"]) {
    await page.getByRole("button", { name: `${name}: タスクの操作`, exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("menuitem", { name: "削除", exact: true }).click();
    await page
      .getByRole("button", { name: `${name}: タスクの操作`, exact: true })
      .waitFor({ state: "detached" });
  }
  await page.screenshot({ path: join(screenshots, "services-desktop.png") });
  await page.locator(".rail").getByRole("button", { name: "MCP接続", exact: true }).click();
  await page.getByRole("heading", { name: "MCP接続", exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 500 });
  const railBefore = await page.locator(".rail").boundingBox();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  assert.ok(await page.evaluate(() => window.scrollY > 0));
  const railAfter = await page.locator(".rail").boundingBox();
  assert.equal(railAfter.y, 0);
  assert.equal(railAfter.height, railBefore.height);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator(".rail").getByRole("button", { name: "プロジェクト一覧" }).click();
  await page.getByRole("heading", { name: "プロジェクト一覧", exact: true }).waitFor();
  await page.reload();
  assert.equal(new URL(page.url()).pathname, "/projects", "projects page survives reload");
  assert.equal(await page.getByLabel("プロジェクト名", { exact: true }).inputValue(), "dot kanban");
  await page.getByRole("button", { name: "dot kanban: アイコンを選択", exact: true }).click();
  assert.equal(
    await picker
      .getByRole("button", { name: "ロケット", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await picker.getByRole("button", { name: "ハート", exact: true }).click();
  await picker.press("Escape");
  assert.equal(
    await page.locator(".project-list-row .icon-rocket").count(),
    1,
    "cancel leaves the original icon",
  );
  await page.getByRole("button", { name: "dot kanban: アイコンを選択", exact: true }).click();
  await picker.getByRole("button", { name: "コード", exact: true }).click();
  await picker.getByRole("button", { name: "適用", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("保存しました", { exact: true }).waitFor();
  assert.equal(config.services[0].icon, "symbol:code");
  await page.getByRole("button", { name: "dot kanban: アイコンを選択", exact: true }).click();
  await picker.getByRole("button", { name: "ロケット", exact: true }).click();
  await picker.getByRole("button", { name: "適用", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("保存しました", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "settings have no horizontal overflow",
  );
  await assertMobileInputSizes(page);
  console.log("PASS project settings UI checks");
  await page.screenshot({ path: join(screenshots, "services-mobile.png") });
  await mobileNavigate(page, "ボード");
  assert.equal(
    await page.getByLabel("言語", { exact: true }).count(),
    0,
    "language only lives in Settings",
  );
  await page.getByRole("button", { name: "新しいタスク" }).click();
  const drawer = page.locator(".drawer");
  assert.equal(
    await drawer
      .locator(".drawer-head .icon-button")
      .evaluate((button) => getComputedStyle(button).color),
    "rgb(61, 89, 76)",
    "close icon uses the shared control color",
  );
  await assertMobileInputSizes(page);
  const project = drawer.getByRole("combobox", { name: "対象プロジェクト", exact: true });
  assert.equal(await drawer.getByLabel("期限", { exact: true }).count(), 0);
  assert.equal(await drawer.getByLabel("状態", { exact: true }).count(), 0);
  for (const label of ["エージェント", "モデル", "実行先"])
    assert.equal(
      await drawer.getByLabel(label, { exact: true }).count(),
      0,
      "task creation delegates execution to MCP client",
    );
  await drawer.getByLabel("タイトル", { exact: false }).fill("Polish the issue UI");
  await drawer.getByLabel("説明", { exact: true }).fill("Keep this draft while adding a project.");
  await project.click();
  await drawer.getByRole("option", { name: "dot kanban", exact: true }).waitFor();
  await project.fill("dot");
  assert.equal(await drawer.locator(".project-suggestions").getByRole("option").count(), 1);
  await project.press("ArrowDown");
  await project.press("Enter");
  assert.equal(await project.inputValue(), "dot kanban");
  assert.equal(await drawer.locator(".project-icon-trigger .icon-rocket").count(), 1);
  await drawer.getByRole("button", { name: "アイコンを選択", exact: true }).click();
  await picker.waitFor();
  assert.equal(
    await picker.evaluate((element) => element.matches(":modal")),
    true,
    "registered projects use the shared icon modal",
  );
  await picker.getByRole("button", { name: "ハート", exact: true }).click();
  await picker.getByRole("button", { name: "キャンセル", exact: true }).click();
  assert.equal(config.services[0].icon, "symbol:rocket", "cancel preserves the project icon");
  await project.fill("Uploaded project");
  assert.equal(
    await drawer.locator(".project-suggestions").getByRole("option").count(),
    0,
    "free text can continue beyond suggestions",
  );
  await drawer.getByRole("button", { name: "アイコンを選択", exact: true }).click();
  await picker.waitFor();
  assert.equal(await picker.evaluate((element) => element.matches(":modal")), true);
  await picker.getByRole("button", { name: "適用", exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await picker.evaluate((element) => element.contains(document.activeElement)),
    true,
    "modal traps focus",
  );
  await picker.screenshot({ path: join(screenshots, "shared-icon-modal-mobile.png") });
  await picker.locator("input[type=file]").setInputFiles({
    name: "too-large.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(2 * 1024 * 1024 + 1),
  });
  await picker.getByRole("alert").waitFor();
  assert.equal(uploadedBytes, undefined);
  for (const name of ["Apple", "Windows", "カレンダー"]) {
    await picker.getByRole("button", { name, exact: true }).click();
    assert.equal(
      await picker.getByRole("button", { name, exact: true }).getAttribute("aria-pressed"),
      "true",
    );
    assert.ok((await picker.locator(".icon-modal-preview path").getAttribute("d")).length > 20);
  }
  await picker.getByRole("button", { name: "Apple", exact: true }).click();
  await page.screenshot({ path: join(screenshots, "project-platform-calendar-icons.png") });
  await picker.locator("input[type=file]").setInputFiles({
    name: "project.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#143c31"/><circle cx="200" cy="100" r="65" fill="#d6f788"/></svg>',
    ),
  });
  await picker.locator(".icon-modal-preview img").waitFor();

  assert.equal(uploadedBytes.readUInt32BE(16), 128);
  assert.equal(uploadedBytes.readUInt32BE(20), 128);
  await picker.getByRole("button", { name: "適用", exact: true }).click();
  await drawer.locator(".description-editor input[type=file]").setInputFiles({
    name: "new-task.png",
    mimeType: "image/png",
    buffer: readFileSync("public/icon-192.png"),
  });
  await drawer.locator(".description-previews img").waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".description-editor textarea").disabled,
  );
  await drawer.getByRole("button", { name: "作成", exact: true }).click();
  await drawer.locator(".detail").waitFor();
  assert.equal(tasks[0].status, "backlog");
  assert.equal(tasks[0].due_date, null);
  assert.equal(tasks[0].project, "Uploaded project");
  assert.equal(config.services.length, 2);
  assert.equal(config.services[1].icon, uploadedPath);
  assert.equal(
    await drawer.locator(".detail > :first-child").getAttribute("class"),
    "drawer-project-row",
  );
  assert.equal(await drawer.getByRole("button", { name: "変更", exact: true }).count(), 0);
  assert.equal(await drawer.locator(".event-form,.routing-summary,.dispatch").count(), 0);
  assert.equal(await drawer.getByText("タスクを編集", { exact: true }).count(), 0);
  assert.equal(
    await drawer
      .getByText("一致ルールはありません。自動実行は始まりません。", { exact: true })
      .count(),
    0,
  );
  assert.equal(await drawer.getByRole("link").count(), 1);
  await drawer.getByText("調査が完了しました。", { exact: true }).waitFor();
  await project.fill("dot kanban");
  assert.equal(
    await drawer.locator(".project-icon-trigger .icon-rocket").count(),
    1,
    "exact input adopts existing icon before saving",
  );
  await project.press("Tab");
  await page.waitForFunction(() => document.querySelector(".task-card .icon-rocket"));
  assert.equal(config.services.length, 2, "exact match does not register duplicate project");
  assert.equal(tasks[0].project, "dot kanban");
  assert.deepEqual(lastProjectPatch, { project: "dot kanban" });
  const projectTaskVersion = tasks[0].version;
  await drawer.getByRole("button", { name: "アイコンを選択", exact: true }).click();
  await picker.getByRole("button", { name: "ハート", exact: true }).click();
  rejectIconSave = true;
  await picker.getByRole("button", { name: "適用", exact: true }).click();
  await drawer.locator(".task-project-editor").getByRole("alert").waitFor();
  assert.equal(
    config.services[0].icon,
    "symbol:rocket",
    "failed save preserves the registered icon",
  );
  rejectIconSave = false;
  await drawer
    .locator(".task-project-editor")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.waitForFunction(() => document.querySelector(".task-card .icon-heart"));
  assert.equal(config.services[0].icon, "symbol:heart", "drawer edits the shared registered icon");
  assert.equal(
    tasks[0].version,
    projectTaskVersion,
    "changing a shared icon does not edit the task",
  );
  assert.equal(config.services.length, 2, "icon change does not create another project");
  await page.reload();
  await drawer.locator(".project-icon-trigger .icon-heart").waitFor();
  await drawer.getByRole("button", { name: "アイコンを選択", exact: true }).click();
  await picker.getByRole("button", { name: "ロケット", exact: true }).click();
  await picker.getByRole("button", { name: "適用", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".task-card .icon-rocket"));

  await project.fill("Drawer project");
  await drawer.getByRole("button", { name: "アイコンを選択", exact: true }).click();
  await picker.getByRole("button", { name: "ハート", exact: true }).click();
  await picker.getByRole("button", { name: "適用", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".task-card .icon-heart"));
  assert.equal(
    config.services.find((service) => service.name === "Drawer project").icon,
    "symbol:heart",
  );
  assert.equal(config.services[0].icon, "symbol:rocket", "existing project icon remains unchanged");
  assert.equal(
    await drawer.getByText("タスクの詳細", { exact: true }).count(),
    0,
    "drawer header shows the task title",
  );
  assert.equal(
    await drawer
      .locator(".drawer-head")
      .getByRole("textbox", { name: "タイトル", exact: true })
      .count(),
    1,
  );
  assert.deepEqual(
    await drawer.locator(".timeline-item p").allTextContents(),
    ["調査が完了しました。", "調査を開始しました。"],
    "history is newest first",
  );
  const title = drawer.getByRole("textbox", { name: "タイトル", exact: true });
  const description = drawer.getByRole("textbox", { name: "説明", exact: true });
  await title.fill("A clearer title edited directly in the drawer");
  await description.click();
  await description.fill("Updated body without an edit button.");
  await project.click();
  await page.waitForFunction(
    () => !document.querySelector(".inline-description textarea")?.disabled,
  );
  assert.equal(tasks[0].description, "Updated body without an edit button.");
  const screenshotBytes = readFileSync("public/icon-192.png");
  await drawer
    .locator(".description-editor input[type=file]")
    .setInputFiles({ name: "screen.png", mimeType: "image/png", buffer: screenshotBytes });
  await drawer.locator(".description-previews img").waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".description-editor textarea").disabled,
  );
  assert.ok(
    tasks[0].description.includes("![screen.png](/api/task-images/"),
    "file attachment saved in description",
  );
  await description.evaluate((element, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    element.setSelectionRange(0, 0);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, screenshotBytes.toString("base64"));
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".description-previews img").length === 2 &&
      !document.querySelector(".description-editor textarea").disabled,
  );
  assert.ok(tasks[0].description.startsWith("\n![pasted.png]"), "paste inserts at the caret");
  await page.reload();
  await drawer.locator(".description-previews img").first().waitFor();
  assert.equal(
    await drawer.locator(".description-previews img").count(),
    2,
    "attachments survive reload",
  );
  assert.ok(
    await drawer
      .locator(".description-previews img")
      .first()
      .evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  await page.screenshot({ path: join(screenshots, "description-images.png") });
  await drawer.getByRole("button", { name: "画像を取り除く: pasted.png", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".description-previews img").length === 1 &&
      !document.querySelector(".description-editor textarea").disabled,
  );
  assert.ok(!tasks[0].description.includes("pasted.png"), "image removal is saved");
  assert.equal(tasks[0].title, "A clearer title edited directly in the drawer");
  assert.equal(tasks[0].status, "backlog");
  assert.equal(
    await drawer.getByLabel("優先度", { exact: true }).count(),
    0,
    "priority is no longer editable",
  );
  rejectProjectChange = true;
  await project.fill("dot kanban");
  await project.press("Enter");
  await drawer.locator(".task-project-editor").getByRole("alert").waitFor();
  assert.equal(tasks[0].project, "Drawer project");
  rejectProjectChange = false;
  await drawer
    .locator(".task-project-editor")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.waitForFunction(() => document.querySelector(".task-card .icon-rocket"));
  await page.setViewportSize({ width: 1600, height: 1000 });
  assert.ok((await drawer.boundingBox()).width >= 700, "drawer has room for longer titles");
  await page.screenshot({ path: join(screenshots, "direct-detail-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator(".drawer-head").count(), 1);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await assertMobileInputSizes(page);
  await drawer.screenshot({ path: join(screenshots, "direct-detail-mobile.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await drawer.getByRole("button", { name: "閉じる", exact: true }).click();
  const card = page.locator(".task-card").first();
  assert.equal(await card.locator(":scope > :first-child").getAttribute("class"), "issue-title");
  assert.equal(await card.locator(".card-panel-time").textContent(), "いま");
  assert.ok(
    (await card.locator(".card-panel-time").getAttribute("title")).startsWith("このパネルに移動:"),
  );
  assert.equal(
    await card.locator(".card-priority,.priority").count(),
    0,
    "cards have no priority field",
  );
  assert.equal(await card.locator(".dispatch,.card-foot").count(), 0);
  assert.equal(
    await card
      .locator(".task-execution")
      .getByRole("img", { name: "ChatGPT", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await card.locator(".task-execution").count(),
    0,
    "unspecified model has no card badge",
  );
  assert.ok(
    !(await card.textContent()).includes("Updated body without an edit button."),
    "body only appears in task details",
  );
  await page.reload();
  await page.locator(".task-card .icon-rocket").waitFor();
  await page.locator(".task-card").first().click();
  assert.equal(await title.inputValue(), "A clearer title edited directly in the drawer");
  assert.equal(await description.inputValue(), tasks[0].description);
  await drawer.getByRole("button", { name: "閉じる", exact: true }).click();
  tasks[0].status = "review";
  tasks.push(
    {
      ...tasks[0],
      id: "33333333-3333-4333-8333-333333333333",
      title: "Running task",
      status: "in_progress",
    },
    {
      ...tasks[0],
      id: "44444444-4444-4444-8444-444444444444",
      title: "Stopped task",
      status: "stopped",
    },
  );
  await reloadBoard(page);
  await showPanel(page, "in_progress");
  const activeColumn = page.locator('.column[data-drop-status="in_progress"]');
  assert.equal(await page.locator(".column").count(), 4);
  assert.deepEqual(
    await activeColumn
      .locator(".task-wrap")
      .evaluateAll((cards) => cards.map((card) => card.className.match(/task-state-(\w+)/)[1])),
    ["review", "stopped", "in_progress"],
  );
  assert.equal(await activeColumn.locator(".count").textContent(), "3");
  assert.notEqual(
    await activeColumn
      .locator(".task-state-review .task-card")
      .evaluate((card) => getComputedStyle(card).backgroundColor),
    await activeColumn
      .locator(".task-state-stopped .task-card")
      .evaluate((card) => getComputedStyle(card).backgroundColor),
  );
  await page.screenshot({ path: join(screenshots, "grouped-active-mobile.png") });
  await activeColumn.locator(".task-state-review .task-card").click();
  assert.equal(await drawer.getByRole("textbox", { name: "タイトル", exact: true }).count(), 0);
  assert.equal(await drawer.getByRole("textbox", { name: "説明", exact: true }).count(), 0);
  await drawer
    .getByRole("heading", { name: "A clearer title edited directly in the drawer" })
    .waitFor();
  await drawer.getByRole("button", { name: "閉じる", exact: true }).click();
  await activeColumn
    .getByRole("button", { name: "Stopped task: タスクの操作", exact: true })
    .click();
  await activeColumn.getByRole("menuitem", { name: "未着手に戻す", exact: true }).click();
  await page
    .locator('.column[data-drop-status="todo"]')
    .getByText("Stopped task", { exact: true })
    .waitFor();
  assert.equal(tasks[2].status, "todo");
  await showPanel(page, "in_progress");
  await activeColumn.locator(".task-state-review .task-card").click();
  await drawer.getByRole("button", { name: "未着手に戻す", exact: true }).click();
  await drawer
    .getByRole("button", { name: "未着手に戻す", exact: true })
    .waitFor({ state: "detached" });
  assert.equal(tasks[0].status, "todo");
  await drawer.getByRole("button", { name: "閉じる", exact: true }).click();
  const dragViewport = page.viewportSize();
  await page.setViewportSize({ width: 1600, height: 1000 });
  for (const status of ["review", "stopped"]) {
    tasks[0].status = status;
    await reloadBoard(page);
    const update = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/tasks/${tasks[0].id}`,
    );
    await page
      .locator(`.task-state-${status} .task-card`)
      .dragTo(page.locator('.column[data-drop-status="done"] .cards'));
    assert.equal((await update).status(), 200);
    await page
      .locator(`.column[data-drop-status="done"] [data-task-id="${tasks[0].id}"]`)
      .waitFor();
    assert.equal(tasks[0].status, "done", `${status} can be dragged to Done`);
  }
  await page.setViewportSize(dragViewport);
  tasks.splice(1);
  tasks[0].status = "backlog";
  config.agents.push({
    id: "codex",
    label: "Codex",
    adapter: "codex_cli",
    enabled: true,
    target_kinds: ["device"],
  });
  config.models.push({
    id: "model-example",
    label: "Example Model",
    agent_id: "codex",
    enabled: true,
    target_kinds: ["device"],
  });
  tasks[0].agent_preference = "codex";
  tasks[0].model_preference = "model-example";
  const taskTemplate = tasks[0];
  tasks.push(
    { ...taskTemplate, id: "done-one", title: "Completed one", status: "done" },
    { ...taskTemplate, id: "done-two", title: "Completed two", status: "done" },
  );
  await reloadBoard(page);
  await showPanel(page, "done");
  const done = page.locator('.column[data-drop-status="done"]');
  await done.getByText("Completed one", { exact: true }).waitFor();
  assert.equal(await page.locator(".archive-pick,.archive-toolbar").count(), 0);
  await done.getByRole("button", { name: "Completed one: タスクの操作", exact: true }).click();
  assert.equal(await page.getByRole("dialog").count(), 0, "menu click does not open the drawer");
  await done.getByRole("menuitem", { name: "アーカイブ", exact: true }).click();
  await done.locator('[data-task-id="done-one"]').waitFor({ state: "detached" });
  assert.deepEqual(lastArchive.tasks, [{ id: "done-one", version: tasks[0].version }]);
  await done.getByRole("button", { name: "完了タスクの操作" }).click();
  await done.getByRole("menuitem", { name: "完了をすべてアーカイブ" }).click();
  await done.locator('[data-task-id="done-two"]').waitFor({ state: "detached" });
  assert.equal(lastArchive.all, true);
  assert.equal(tasks[0].archived_at, null);
  await done.getByRole("button", { name: "完了タスクの操作" }).click();
  await done.getByRole("menuitemcheckbox", { name: /アーカイブ済みを表示/ }).click();
  await done.locator(".task-wrap.archived").first().waitFor();
  assert.equal(await done.locator(".task-wrap.archived").count(), 2);
  await page.screenshot({ path: join(screenshots, "compact-board-mobile.png") });
  await page.setViewportSize({ width: 1600, height: 1000 });
  const searchBox = await page.getByRole("textbox", { name: "タスクを検索" }).boundingBox();
  const createBox = await page.getByRole("button", { name: "新しいタスク" }).boundingBox();
  assert.ok(searchBox.x < createBox.x && Math.abs(searchBox.y - createBox.y) < 10);
  assert.equal(
    await page.locator(".task-card").first().locator(".execution-model").textContent(),
    "Example Model",
  );
  assert.equal(
    await page
      .locator(".task-card")
      .first()
      .getByRole("img", { name: "ChatGPT", exact: true })
      .count(),
    0,
  );
  assert.ok(
    await page
      .locator(".rail .brand img")
      .evaluate(
        (image) => image.complete && image.naturalWidth > 0 && image.src.includes("/icon.svg"),
      ),
    "sidebar uses the shared SVG logo",
  );
  const compactAgent = page.locator(".task-wrap").first().locator(".card-agent .agent-icon");
  assert.equal(
    await compactAgent.getAttribute("aria-label"),
    "ChatGPT",
    "single connection still shows its icon",
  );
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  const iconBounds = await compactAgent.boundingBox();
  const timeBounds = await page.locator(".card-panel-time").first().boundingBox();
  assert.ok(
    iconBounds.height <= 16 && Math.abs(iconBounds.y - timeBounds.y) < 2,
    `agent shares the date row without adding height: ${JSON.stringify({ iconBounds, timeBounds })}`,
  );
  assert.ok(
    (await page.locator(".column").first().boundingBox()).width >= 285,
    "columns are about 1.5 times wider",
  );
  await page.setViewportSize({ width: 1100, height: 1000 });
  const headerBefore = await page.locator(".board-header").boundingBox();
  const columnBefore = await page.locator(".column").first().boundingBox();
  await page.locator(".board-scroll").evaluate((element) => {
    element.scrollLeft = 400;
  });
  assert.ok(
    (await page.locator(".column").first().boundingBox()).x < columnBefore.x - 100,
    "board scrolls horizontally",
  );
  assert.deepEqual(
    await page.locator(".board-header").boundingBox(),
    headerBefore,
    "search and new task stay fixed when the board scrolls",
  );
  await page.screenshot({ path: join(screenshots, "wide-board-scrolled-desktop.png") });
  await page.locator(".board-scroll").evaluate((element) => {
    element.scrollLeft = 0;
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.screenshot({ path: join(screenshots, "compact-board-desktop.png") });
  await page.locator(".rail").getByRole("button", { name: "設定" }).click();
  await page.getByLabel("言語", { exact: true }).selectOption("en");
  await page.reload();
  assert.equal(new URL(page.url()).pathname, "/settings", "settings survives reload");
  assert.equal(await page.getByLabel("Language", { exact: true }).inputValue(), "en");
  await page.getByLabel("Language", { exact: true }).selectOption("ja");
  assert.equal(
    await page.getByLabel("担当エージェント", { exact: true }).count(),
    0,
    "single connection has no task selector",
  );
  connections.push(
    {
      id: "claude-connection",
      client_id: "claude-client",
      client_name: "Claude",
      scopes: ["tasks:read", "tasks:write"],
      created_at: 1700000001,
    },
    {
      id: "grok-connection",
      client_id: "grok-client",
      client_name: "Grok",
      scopes: ["tasks:read", "tasks:write"],
      created_at: 1700000002,
    },
  );
  for (const name of ["Codex", "Gemini CLI", "Cursor"])
    connections.push({
      id: name.toLowerCase().replaceAll(" ", "-") + "-connection",
      client_id: name.toLowerCase(),
      client_name: name,
      scopes: ["tasks:read", "tasks:write"],
      created_at: 1700000003,
    });
  await page.locator(".rail").getByRole("button", { name: "ボード" }).click();
  await page.locator(".rail").getByRole("button", { name: "MCP接続" }).click();
  const claudeRow = page
    .locator(".mcp-connections .setting-row")
    .filter({ has: page.getByText("Claude", { exact: true }) });
  await claudeRow.getByRole("img", { name: "Claude", exact: true }).waitFor();
  assert.equal(await page.locator(".mcp-connections .agent-icon-grok").count(), 1);
  await claudeRow.getByRole("button", { name: "デフォルトにする", exact: true }).click();
  await claudeRow.getByText("デフォルト", { exact: true }).waitFor();
  assert.equal(defaultConnectionId, "claude-connection");
  assert.ok(
    await page
      .locator(".mcp-connections .agent-icon img")
      .evaluateAll(
        (images) =>
          images.length === 6 && images.every((image) => image.complete && image.naturalWidth > 0),
      ),
    "brand logos load under the app CSP",
  );
  await page.screenshot({ path: join(screenshots, "mcp-default-settings.png"), fullPage: true });
  await page.locator(".rail").getByRole("button", { name: "ボード" }).click();
  const assignmentCard = page.locator(".task-wrap").filter({
    has: page.getByRole("heading", { name: "A clearer title edited directly in the drawer" }),
  });
  await assignmentCard.getByRole("button", { name: "担当エージェント", exact: true }).click();
  await assignmentCard.getByRole("menuitemradio", { name: "Grok", exact: true }).click();
  await assignmentCard.locator(".card-agent .agent-icon-grok").waitFor();
  assert.equal(tasks[0].mcp_connection_id, "grok-connection");
  assert.equal(await page.getByRole("dialog").count(), 0, "card assignment does not open drawer");
  await assignmentCard.locator(".task-card").click();
  const agentTrigger = drawer.getByRole("button", { name: "担当エージェント", exact: true });
  await drawer.locator(".agent-picker-trigger .agent-icon-grok").waitFor();
  assert.equal(await agentTrigger.getAttribute("title"), "Grok");
  assert.equal(
    await drawer.locator(".connection-name, .connection-picker select").count(),
    0,
    "drawer shows only an agent icon",
  );
  await agentTrigger.click();
  assert.equal(
    await drawer
      .getByRole("menuitemradio", { name: "Grok", exact: true })
      .getAttribute("aria-checked"),
    "true",
  );
  await drawer.getByRole("menuitemradio", { name: "Claude", exact: true }).click();
  await drawer.locator(".agent-icon-claude").waitFor();
  assert.equal(tasks[0].mcp_connection_id, "claude-connection");
  await page.setViewportSize({ width: 390, height: 844 });
  const projectBounds = await drawer.locator(".project-combobox-control").boundingBox();
  const agentBounds = await agentTrigger.boundingBox();
  assert.ok(
    agentBounds.x >= projectBounds.x + projectBounds.width &&
      Math.abs(agentBounds.y - projectBounds.y) < 3,
    "agent icon sits at the right of the project row",
  );
  await drawer.screenshot({ path: join(screenshots, "mcp-assignment-mobile.png") });
  await agentTrigger.click();
  await drawer.screenshot({ path: join(screenshots, "mcp-agent-menu-mobile.png") });
  await agentTrigger.press("ArrowDown");
  assert.equal(
    await drawer
      .getByRole("menuitemradio")
      .first()
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await drawer.getByRole("menu").count(), 0);
  assert.equal(await agentTrigger.evaluate((element) => element === document.activeElement), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await drawer.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "新しいタスク" }).click();
  assert.equal(await agentTrigger.getAttribute("title"), "Claude", "new task uses default");
  assert.equal(new URL(page.url()).pathname, "/tasks/new");
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector(".task-form .agent-picker-trigger")?.title === "Claude",
  );
  assert.equal(
    await drawer.getByLabel("優先度", { exact: true }).count(),
    0,
    "new task has no priority selector",
  );
  await drawer.getByRole("button", { name: "閉じる", exact: true }).click();
  tasks[0].status = "in_progress";
  await reloadBoard(page);
  await assignmentCard.locator(".task-card").click();
  assert.equal(await agentTrigger.isDisabled(), true);
  await drawer.getByRole("button", { name: "閉じる", exact: true }).click();
  tasks[0].status = "backlog";
  tasks[0].mcp_connection_id = "test-connection";
  connections = connections.filter((item) => item.id === "test-connection");
  defaultConnectionId = "test-connection";
  await reloadBoard(page);
  await page.waitForFunction(() => !document.querySelector(".card-agent .agent-picker-trigger"));
  await assignmentCard.locator(".task-card").click();
  await drawer.getByRole("img", { name: "ChatGPT", exact: true }).waitFor();
  assert.equal(
    await drawer.getByLabel("担当エージェント", { exact: true }).count(),
    0,
    "selector disappears with only one connection",
  );
  assert.equal(await drawer.getByRole("img", { name: "ChatGPT", exact: true }).count(), 1);
  assert.equal(
    await assignmentCard.locator(".agent-icon").count(),
    1,
    "single connection shows a compact card agent icon",
  );
  const detailPath = "/tasks/" + tasks[0].id;
  assert.equal(new URL(page.url()).pathname, detailPath);
  await page.reload();
  await drawer.getByRole("textbox", { name: "タイトル", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, detailPath, "task detail survives reload");
  await page.evaluate(() => {
    window.spaMarker = "still-here";
  });
  await page.goBack();
  await drawer.waitFor({ state: "detached" });
  assert.equal(new URL(page.url()).pathname, "/");
  await page.goForward();
  await drawer.getByRole("textbox", { name: "タイトル", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.spaMarker),
    "still-here",
    "back/forward update the drawer without a document navigation",
  );

  await drawer.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.locator(".rail").getByRole("button", { name: "プロジェクト一覧" }).click();
  const removedProject = config.services.find((service) => service.name === tasks[0].project);
  const removedName = removedProject.name;
  const projectRow = page.locator(".project-list-row").filter({
    has: page.getByRole("button", { name: removedName + ": アイコンを選択", exact: true }),
  });
  await projectRow.locator(".overflow-trigger").click();
  page.once("dialog", (dialog) => dialog.accept());
  await projectRow.getByRole("menuitem", { name: "削除", exact: true }).click();
  await projectRow.waitFor({ state: "detached" });
  assert.ok(
    !config.services.some((service) => service.id === removedProject.id),
    "deletion is persisted without Save",
  );
  await page.locator(".rail").getByRole("button", { name: "ボード" }).click();
  await assignmentCard.locator(".task-card").click();
  await drawer.getByRole("combobox", { name: "対象プロジェクト", exact: true }).click();
  assert.equal(
    await drawer.getByRole("option", { name: removedName, exact: true }).count(),
    0,
    "deleted project absent from suggestions",
  );
  await drawer.getByRole("combobox", { name: "対象プロジェクト", exact: true }).press("Tab");
  await drawer.getByRole("textbox", { name: "説明", exact: true }).click();
  await drawer.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.locator(".rail").getByRole("button", { name: "プロジェクト一覧" }).click();
  await page.getByRole("heading", { name: "プロジェクト一覧", exact: true }).waitFor();
  assert.ok(
    !config.services.some((service) => service.name === removedName),
    "unchanged orphan task project does not recreate deleted entry",
  );
  assert.ok(
    !(
      await page
        .getByRole("textbox", { name: "プロジェクト名", exact: true })
        .evaluateAll((inputs) => inputs.map((input) => input.value))
    ).includes(removedName),
  );
  await page.locator(".rail").getByRole("button", { name: "MCP接続", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "接続を解除", exact: true }).click();
  await page
    .locator(".mcp-connections")
    .getByText("ChatGPT", { exact: true })
    .waitFor({ state: "detached" });
  assert.equal(connections.length, 0);
  const cdp = await context.newCDPSession(page);
  await page.goto(base + "/without-manifest-credentials");
  const brokenManifest = await cdp.send("Page.getAppManifest");
  assert.equal(
    brokenManifest.data,
    "",
    "cookie-protected manifest cannot load without credentials",
  );
  await page.goto(base);
  const manifest = await cdp.send("Page.getAppManifest");
  assert.deepEqual(manifest.errors, [], "authenticated manifest loads without errors");
  assert.equal(JSON.parse(manifest.data).display, "standalone");
  assert.deepEqual(
    JSON.parse(manifest.data).icons.map((icon) => icon.sizes),
    ["any", "192x192", "512x512"],
  );
  assert.ok(
    manifestRequests.includes(false) && manifestRequests.includes(true),
    "verified credential omission and inclusion in Chrome",
  );
  const installability = await cdp.send("Page.getInstallabilityErrors");
  assert.deepEqual(
    installability.installabilityErrors.filter((error) => error.errorId !== "in-incognito"),
    [],
    "no PWA installability errors beyond the isolated browser context",
  );

  console.log("START automatic sync checks");
  // Automatic synchronization: only the tiny revision endpoint is polled.
  await page.clock.install();
  const tick = async (ms = 3500) => {
    await page.clock.runFor(ms);
    await page.clock.resume();
  };
  const revisionResponse = () =>
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/board/revision");
  const boardResponse = () =>
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/tasks");
  let revisionResponsePromise = revisionResponse();
  let boardResponsePromise = boardResponse();
  await page.reload();
  await revisionResponsePromise;
  await boardResponsePromise;
  await page.locator(".task-card").first().waitFor();
  revisionResponsePromise = revisionResponse();
  await tick();
  await revisionResponsePromise;
  console.log("PASS initial live sync");
  const unchangedReads = boardReads;
  revisionResponsePromise = revisionResponse();
  await tick();
  assert.equal((await revisionResponsePromise).status(), 304);
  assert.equal(boardReads, unchangedReads, "unchanged board does not fetch tasks");

  tasks[0].title = "Live sync check";
  boardResponsePromise = boardResponse();
  await tick();
  await boardResponsePromise;
  await page.getByRole("heading", { name: "Live sync check" }).waitFor();
  const search = page.getByRole("textbox", { name: "タスクを検索", exact: true });
  await search.fill("Live sync");
  tasks[0].status = "in_progress";
  boardResponsePromise = boardResponse();
  await tick();
  await boardResponsePromise;
  await page
    .locator('.column[data-drop-status="in_progress"]')
    .getByRole("heading", { name: "Live sync check" })
    .waitFor();
  assert.equal(await search.inputValue(), "Live sync", "sync preserves the search");
  tasks.push({
    ...tasks[0],
    id: "55555555-5555-4555-8555-555555555555",
    title: "Live sync new task",
    status: "todo",
  });
  boardResponsePromise = boardResponse();
  await tick();
  await boardResponsePromise;
  await page.getByRole("heading", { name: "Live sync new task" }).waitFor();
  tasks[tasks.length - 1].status = "done";
  tasks[tasks.length - 1].archived_at = new Date().toISOString();
  boardResponsePromise = boardResponse();
  await tick();
  await boardResponsePromise;
  await page.getByRole("heading", { name: "Live sync new task" }).waitFor({ state: "detached" });

  console.log("PASS live changes and archive");
  // Holding a card never replaces its DOM while dragging.
  await page.evaluate(() => window.dispatchEvent(new Event("dragstart")));
  tasks[0].title = "Live sync after drag";
  const dragReads = boardReads;
  await tick(15_000);
  assert.equal(boardReads, dragReads);
  boardResponsePromise = boardResponse();
  await page.evaluate(() => window.dispatchEvent(new Event("dragend")));
  await tick(100);
  await boardResponsePromise;
  await page.getByRole("heading", { name: "Live sync after drag" }).waitFor();

  console.log("PASS drag guard");
  // A failed fetch must not acknowledge the revision or erase existing data.
  failBoardRead = true;
  tasks[0].title = "Live sync after retry";
  boardResponsePromise = boardResponse();
  await tick();
  assert.equal((await boardResponsePromise).status(), 503);
  await page.getByRole("heading", { name: "Live sync after drag" }).waitFor();
  failBoardRead = false;
  boardResponsePromise = boardResponse();
  await tick(6500);
  await boardResponsePromise;
  await page.getByRole("heading", { name: "Live sync after retry" }).waitFor();

  await page.locator(".rail").getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("heading", { name: "設定", exact: true }).waitFor();
  const settingsRevisionReads = revisionReads;
  await tick(30_000);
  assert.equal(revisionReads, settingsRevisionReads, "settings pauses synchronization");
  await page.locator(".rail").getByRole("button", { name: "ボード", exact: true }).click();
  await page.getByRole("heading", { name: "Live sync after retry" }).waitFor();
  await page.getByRole("button", { name: "新しいタスク" }).click();
  await drawer.getByRole("textbox", { name: "タイトル" }).fill("Unsaved live draft");
  const drawerRevisionReads = revisionReads;
  tasks[0].title = "Live sync after drawer";
  await tick(30_000);
  assert.equal(revisionReads, drawerRevisionReads, "drawer pauses synchronization");
  assert.equal(
    await drawer.getByRole("textbox", { name: "タイトル" }).inputValue(),
    "Unsaved live draft",
  );
  boardResponsePromise = boardResponse();
  await drawer.getByRole("button", { name: "閉じる", exact: true }).click();
  await tick(100);
  await boardResponsePromise;
  await page.getByRole("heading", { name: "Live sync after drawer" }).waitFor();

  console.log("PASS retry, settings and draft guards");
  // Cancel in-flight automatic requests before opening an editable drawer.
  holdBoardReads = true;
  tasks[0].title = "Live sync delayed response";
  const heldRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/tasks",
  );
  await tick();
  await heldRequest;
  await page.getByRole("button", { name: "新しいタスク" }).click();
  await drawer.getByRole("textbox", { name: "タイトル" }).fill("Keep this draft");
  holdBoardReads = false;
  for (const release of heldBoardReads.splice(0)) release();
  await tick(1000);
  assert.equal(
    await drawer.getByRole("textbox", { name: "タイトル" }).inputValue(),
    "Keep this draft",
  );
  assert.equal(
    await page.getByRole("heading", { name: "Live sync delayed response" }).count(),
    0,
    "cancelled response does not overwrite the board",
  );
  boardResponsePromise = boardResponse();
  await drawer.getByRole("button", { name: "閉じる", exact: true }).click();
  await tick(100);
  await boardResponsePromise;
  await page.getByRole("heading", { name: "Live sync delayed response" }).waitFor();

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenRevisionReads = revisionReads;
  await tick(30_000);
  assert.equal(revisionReads, hiddenRevisionReads, "hidden tab stops requests");
  tasks[0].title = "Live sync after returning";
  boardResponsePromise = boardResponse();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await tick(100);
  await boardResponsePromise;
  await page.getByRole("heading", { name: "Live sync after returning" }).waitFor();
  // Real touch gestures in a mobile viewport, with background polling isolated.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // Enough cards to verify scrolling inside a viewport-height panel.
  for (let index = 0; index < 12; index++)
    tasks.push({
      ...tasks[0],
      id: crypto.randomUUID(),
      title: `Scrollable task ${index}`,
      status: "in_progress",
      archived_at: null,
    });
  const touchContext = await browser.newContext({
    locale: "ja-JP",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const touchPage = await touchContext.newPage();
  await touchPage.route("**/api/board/revision", (route) => route.fulfill({ status: 304 }));
  await touchPage.goto(base);
  await touchPage.locator('.column[data-drop-status="backlog"]').waitFor();
  const touchCdp = await touchContext.newCDPSession(touchPage);
  const swipe = async (locator, dx, dy, { hold = 0, cancel = false, release = true } = {}) => {
    // Let Chrome finish the preceding native gesture before starting another.
    await touchPage.waitForTimeout(150);
    const box = await locator.boundingBox();
    assert.ok(box);
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await touchCdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    if (hold) await touchPage.waitForTimeout(hold);
    for (let step = 1; step <= 5; step++)
      await touchCdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (dx * step) / 5, y: y + (dy * step) / 5 }],
      });
    if (release)
      await touchCdp.send("Input.dispatchTouchEvent", {
        type: cancel ? "touchCancel" : "touchEnd",
        touchPoints: [],
      });
  };
  assert.equal(await touchPage.locator(".mobile-tabs,.mobile-main-nav").count(), 0);
  const boardSurface = touchPage.locator(".board-scroll");
  const firstPanel = touchPage.locator('.column[data-drop-status="backlog"]');
  assert.equal(
    Math.round((await firstPanel.boundingBox()).width),
    Math.round((await boardSurface.boundingBox()).width),
  );
  await touchPage.locator(".mobile-menu-toggle").tap();
  const mobileMenu = touchPage.locator(".mobile-menu");
  await mobileMenu.waitFor();
  await touchPage.waitForTimeout(220);
  const menuBox = await mobileMenu.boundingBox();
  assert.equal(Math.round(menuBox.x + menuBox.width), 390, "menu enters from right edge");
  await touchPage.screenshot({ path: join(screenshots, "mobile-menu.png") });
  await touchPage.keyboard.press("Escape");
  await mobileMenu.waitFor({ state: "hidden" });
  const labels = touchPage.locator(".mobile-panel-labels");
  assert.equal(await labels.locator("li").count(), 4);
  assert.equal(
    await firstPanel.locator(".column-head").isVisible(),
    false,
    "panel titles move above the board",
  );
  assert.equal(await labels.locator("[aria-current]").textContent(), "バックログ0");
  const toggleStyle = await touchPage.locator(".mobile-menu-toggle").evaluate((button) => ({
    background: getComputedStyle(button).backgroundColor,
    border: getComputedStyle(button).borderWidth,
  }));
  assert.deepEqual(toggleStyle, { background: "rgba(0, 0, 0, 0)", border: "0px" });
  await swipe(firstPanel, -170, 0);
  await touchPage.waitForFunction(() => {
    const surface = document.querySelector(".board-scroll");
    const panel = document.querySelector('.column[data-drop-status="todo"]');
    return Math.abs(surface.getBoundingClientRect().left - panel.getBoundingClientRect().left) < 2;
  });
  await touchPage.waitForFunction(() =>
    document.querySelector(".mobile-panel-labels [aria-current]")?.textContent.startsWith("未着手"),
  );
  await touchPage.waitForTimeout(320);
  const highlight = await touchPage.locator(".mobile-panel-highlight").boundingBox();
  const currentLabel = await labels.locator("[aria-current]").boundingBox();
  assert.ok(
    Math.abs(highlight.x - currentLabel.x) < 1 &&
      Math.abs(highlight.width - currentLabel.width) < 1,
    "highlight settles under the visible panel name",
  );
  assert.equal(
    await touchPage
      .locator(".mobile-panel-highlight")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    await firstPanel.evaluate((element) => getComputedStyle(element).backgroundColor),
  );
  const panelBottom = (await firstPanel.boundingBox()).y + (await firstPanel.boundingBox()).height;
  assert.ok(panelBottom >= 828 && panelBottom <= 844, "panel reaches the bottom safe area");
  assert.equal(
    await touchPage.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
    true,
    "board page stays within viewport",
  );
  await touchPage.screenshot({ path: join(screenshots, "mobile-carousel.png") });
  for (const [label, status] of [
    ["完了", "done"],
    ["実行中", "in_progress"],
    ["バックログ", "backlog"],
  ]) {
    await labels.getByRole("button", { name: label, exact: true }).tap();
    await touchPage.waitForFunction((status) => {
      const surface = document.querySelector(".board-scroll");
      const panel = document.querySelector(`[data-drop-status="${status}"]`);
      return (
        Math.abs(surface.getBoundingClientRect().left - panel.getBoundingClientRect().left) < 2
      );
    }, status);
    assert.equal(
      await labels.getByRole("button", { name: label, exact: true }).getAttribute("aria-pressed"),
      "true",
    );
  }
  const touchHead = firstPanel;
  const touchStatus = touchPage.locator(".pull-refresh");
  const beforePull = boardReads;
  await swipe(touchHead, 0, 35);
  await swipe(touchHead, 100, 10);
  await swipe(touchHead, 0, 120, { cancel: true });
  assert.equal(boardReads, beforePull, "short, horizontal and cancelled pulls do not refresh");
  holdBoardReads = true;
  await swipe(touchHead, 0, 120, { release: false });
  await touchStatus.getByText("離して更新", { exact: true }).waitFor();
  assert.equal(boardReads, beforePull, "pull waits for release");
  const pullRequest = touchPage.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/tasks",
  );
  await touchCdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await pullRequest;
  await touchStatus.getByText("更新中…", { exact: true }).waitFor();
  await touchPage.screenshot({ path: join(screenshots, "pull-to-refresh-mobile.png") });
  await swipe(touchHead, 0, 120);
  assert.equal(boardReads, beforePull + 1, "only one refresh runs at a time");
  holdBoardReads = false;
  for (const release of heldBoardReads.splice(0)) release();
  await touchStatus.getByText("更新しました", { exact: true }).waitFor();
  failBoardRead = true;
  await swipe(touchHead, 0, 120, { release: false });
  await touchStatus.getByText("離して更新", { exact: true }).waitFor();
  await touchCdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await touchStatus.getByText("処理に失敗しました。", { exact: true }).waitFor();
  failBoardRead = false;
  await swipe(touchHead, 0, 120);
  await touchStatus.getByText("更新しました", { exact: true }).waitFor();
  await showPanel(touchPage, "in_progress");
  const touchCard = touchPage.locator('.column[data-drop-status="in_progress"] .task-card').first();
  await swipe(touchCard, 0, 120, { hold: 350, release: false });
  assert.equal(
    await touchStatus.isVisible(),
    false,
    "long-press card dragging does not arm refresh",
  );
  await touchCdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await touchPage.setViewportSize({ width: 390, height: 500 });
  const activeCards = touchPage.locator('.column[data-drop-status="in_progress"] .cards');
  const fixedLabels = await labels.boundingBox();
  await activeCards.evaluate((element) => {
    element.scrollTop = 180;
  });
  assert.ok(
    await activeCards.evaluate(
      (element) => element.scrollTop > 0 && element.scrollHeight > element.clientHeight,
    ),
  );
  assert.equal(await touchPage.evaluate(() => window.scrollY), 0, "only tickets scroll vertically");
  assert.deepEqual(
    await labels.boundingBox(),
    fixedLabels,
    "panel names remain fixed while tickets scroll",
  );
  const scrolledPullReads = boardReads;
  await swipe(activeCards, 0, 100);
  assert.equal(boardReads, scrolledPullReads, "a gesture inside a scrolled card list only scrolls");
  await activeCards.evaluate((element) => {
    element.scrollTop = 0;
  });
  await touchPage.setViewportSize({ width: 390, height: 844 });
  await touchPage.evaluate(() => window.scrollTo(0, 0));
  await touchPage.getByRole("button", { name: "新しいタスク" }).click();
  const touchDrawer = touchPage.locator(".drawer");
  await touchDrawer.getByRole("textbox", { name: "タイトル" }).fill("Keep pull draft");
  await assertMobileInputSizes(touchPage);
  await touchPage.setViewportSize({ width: 900, height: 500 });
  await assertMobileInputSizes(touchPage);
  await touchPage.setViewportSize({ width: 390, height: 844 });
  const draftPullReads = boardReads;
  await swipe(touchDrawer.locator(".drawer-head"), 0, 120);
  assert.equal(boardReads, draftPullReads, "drawer does not enable pull refresh");
  assert.equal(
    await touchDrawer.getByRole("textbox", { name: "タイトル" }).inputValue(),
    "Keep pull draft",
  );
  await touchDrawer.getByRole("button", { name: "閉じる", exact: true }).click();
  for (const status of ["review", "stopped"]) {
    tasks[0].status = status;
    await reloadBoard(touchPage);
    await showPanel(touchPage, "in_progress");
    const card = touchPage.locator(`.task-state-${status} .task-card`).first();
    await swipe(card, 0, 0, { hold: 350, release: false });
    const box = await card.boundingBox();
    await touchCdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 380, y: box.y + box.height / 2 }],
    });
    await touchPage.waitForFunction(() => {
      const surface = document.querySelector(".board-scroll");
      const done = document.querySelector('.column[data-drop-status="done"]');
      return Math.abs(surface.getBoundingClientRect().left - done.getBoundingClientRect().left) < 2;
    });
    await touchCdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 190, y: box.y + box.height / 2 }],
    });
    const update = touchPage.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/tasks/${tasks[0].id}`,
    );
    await touchCdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.equal((await update).status(), 200);
    await touchPage
      .locator(`.column[data-drop-status="done"] [data-task-id="${tasks[0].id}"]`)
      .waitFor();
    assert.equal(tasks[0].status, "done", `mobile long-press moves ${status} to Done`);
  }
  console.log("PASS review and stopped cards can be dragged to Done on desktop and mobile");
  await touchContext.close();
  console.log(
    "PASS mobile pull-to-refresh, cancellation, single flight, failure recovery and draft preservation",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS direct editing, project suggestions/exact matching/free input/shared icon editing, card layout, overflow archive menus, settings language, PWA and consent",
  );
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
