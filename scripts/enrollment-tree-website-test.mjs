#!/usr/bin/env node
/**
 * Headed browser walk of 202609招生樹 discussion + 問同事 on the local site.
 * Screenshots go to /opt/cursor/artifacts. Never logs secrets.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APP = process.env.ENROLLMENT_SITE_URL || "http://127.0.0.1:5173/";
const CONTROL = process.env.ENROLLMENT_CONTROL_URL || "http://127.0.0.1:54522";
const ART = "/opt/cursor/artifacts";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

mkdirSync(ART, { recursive: true });

const { chromium } = await import("playwright");
const notes = [];
const log = (name, pass, detail = "") => {
  notes.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function openFocusActions(page) {
  await page.evaluate(() => {
    const details = document.querySelector('[data-testid="wb-focus-actions"]');
    if (details instanceof HTMLDetailsElement) details.open = true;
  });
}

async function clickTreeChild(page, label) {
  const clicked = await page.evaluate((name) => {
    const chips = [...document.querySelectorAll(`[data-testid="wb-tree-child"][data-tree-label="${name}"]`)];
    const chip = chips.find((el) => el instanceof HTMLElement);
    if (chip instanceof HTMLElement) {
      chip.click();
      return "chip";
    }
    const node = document.querySelector(`[data-enrollment-label="${name}"]`);
    if (node instanceof HTMLElement) {
      node.click();
      return "node";
    }
    return "";
  }, label);
  if (!clicked) throw new Error(`no tree child ${label}`);
  return clicked;
}

async function createRoom(page, name) {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.fill("input.text-input", name);
  await page.click("button.btn-primary");
  await page.getByRole("button", { name: "建立活動房" }).click();
  await page.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 30000 });
}

async function openEnrollmentBoard(page) {
  await page.getByRole("button", { name: "白板", exact: true }).click();
  const name = page.getByLabel("白板名稱");
  if (await name.count()) {
    await name.fill("202609招生");
    await page.getByRole("button", { name: "建立白板" }).click();
  }
  await page.waitForSelector('[data-testid="wb-start-enrollment-tree"], [data-testid="wb-canvas"]', { timeout: 15000 });
}

const browser = await chromium.launch({
  headless: false,
  args: ["--disable-dev-shm-usage"],
});

const evidence = {
  at: new Date().toISOString(),
  url: APP,
  viewport390: {},
  viewportWide: {},
  reviewer: {},
  ai: {},
};

let inviteUrl = "";

{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_UA,
  });
  const page = await ctx.newPage();
  page.on("request", (req) => {
    if (!req.url().includes("/rpc/create_room_with_invite")) return;
    try {
      const body = req.postDataJSON();
      const roomId = String(body?.p_room_id ?? "");
      const token = String(body?.p_invite_token ?? "");
      if (roomId && token) inviteUrl = `${APP}#room=${encodeURIComponent(roomId)}&invite=${encodeURIComponent(token)}`;
    } catch {
      // ignore
    }
  });

  try {
    await createRoom(page, "招生樹網站測");
    await openEnrollmentBoard(page);
    const starter = page.getByTestId("wb-start-enrollment-tree");
    await starter.waitFor({ timeout: 10000 });
    log("empty-board CTA 有空板長 202609招生骨架", await starter.count() === 1, await starter.innerText().catch(() => ""));
    await starter.click();
    await page.waitForTimeout(500);
    await page.waitForSelector('[data-testid="wb-tree-child"][data-tree-label="書籤"], [data-enrollment-label="書籤"]', { timeout: 10000 });
    await page.screenshot({ path: join(ART, "enrollment_website_tree_on_board_390.png"), fullPage: false });
    evidence.viewport390.treeOnBoard = true;

    await clickTreeChild(page, "書籤");
    await page.waitForFunction(() => {
      const path = document.querySelector('[data-testid="wb-tree-path"]')?.textContent ?? "";
      const empty = document.querySelector('[data-testid="focus-discuss-empty"]')?.textContent ?? "";
      return path.includes("書籤") && empty.includes("書籤");
    }, { timeout: 10000 });
    const pathText = (await page.getByTestId("wb-tree-path").first().textContent()) ?? "";
    const hint = (await page.getByTestId("focus-discuss-empty").first().textContent().catch(() => "")) ?? "";
    log("焦點路徑 202609招生 › 書籤", pathText.includes("202609招生") && pathText.includes("書籤"), pathText);
    log("composer hint 針對書籤留言", hint.includes("202609招生") && hint.includes("書籤"), hint);
    await page.screenshot({ path: join(ART, "enrollment_website_bookmark_hint_390.png"), fullPage: false });
    evidence.viewport390.treePath = pathText.trim();
    evidence.viewport390.composerHint = hint.trim();

    const input = page.getByTestId("discussion-composer-input").first();
    await input.fill("書籤正面要不要補師父法語？原有的先不要換。");
    await page.locator('[data-testid="discussion-composer"] button[type="submit"]').first().click();
    await page.waitForFunction(() => {
      const feed = document.querySelector('[data-testid="discussion-feed"]');
      return (feed?.textContent ?? "").includes("師父法語");
    }, { timeout: 10000 });
    const bookmarkFeed = (await page.getByTestId("discussion-feed").first().textContent()) ?? "";
    log("書籤支線看得到自己的留言", bookmarkFeed.includes("師父法語"), bookmarkFeed.slice(0, 160));
    await page.screenshot({ path: join(ART, "enrollment_website_bookmark_posted_390.png"), fullPage: false });

    const askBtn = page.getByTestId("rd-ask-colleague").first();
    if (await askBtn.count()) {
      await askBtn.click();
    } else {
      await openFocusActions(page);
      await page.getByTestId("wb-ask-colleague").first().click();
    }
    log("點了問同事", true);
    const aiAppeared = await page.waitForFunction(() => {
      const badge = document.querySelector('[data-testid="discussion-ai-badge"]');
      const colleague = document.querySelector('[data-colleague="true"]');
      const feed = document.querySelector('[data-testid="discussion-feed"]')?.textContent ?? "";
      return Boolean(badge || colleague || /Grok|AI 沒有回應|尚未設定|看過這條支線|暫時沒有回應/.test(feed));
    }, { timeout: 90000 }).then(() => true).catch(() => false);
    const feedAfter = (await page.getByTestId("discussion-feed").first().textContent().catch(() => "")) ?? "";
    const grokBody = await page.locator('[data-colleague="true"]').first().innerText().catch(() => "");
    log("問同事後有使用者可見回覆", aiAppeared && Boolean((grokBody || feedAfter).trim()), (grokBody || feedAfter).slice(0, 200));
    await page.screenshot({ path: join(ART, "enrollment_website_ai_reply_390.png"), fullPage: false });
    evidence.ai.visibleReply = aiAppeared;
    evidence.ai.bodyPreview = (grokBody || feedAfter).slice(0, 240);
    evidence.ai.hasGrokBadge = await page.getByTestId("discussion-ai-badge").count() > 0;

    await page.getByTestId("wb-focus-sheet-dismiss").click({ force: true }).catch(() => undefined);
    await page.evaluate(() => {
      const root = document.querySelector('[data-enrollment-label="202609招生"]');
      if (root instanceof HTMLElement) root.click();
    });
    await clickTreeChild(page, "胸章");
    await page.waitForFunction(() => {
      const path = document.querySelector('[data-testid="wb-tree-path"]')?.textContent ?? "";
      return path.includes("胸章");
    }, { timeout: 8000 });
    const badgeFeed = (await page.getByTestId("discussion-feed").first().textContent().catch(() => "")) ?? "";
    const badgeEmpty = (await page.getByTestId("focus-discuss-empty").first().textContent().catch(() => "")) ?? "";
    const scoped = !badgeFeed.includes("師父法語");
    log("胸章旁支看不到書籤留言", scoped, `feed=${badgeFeed.slice(0, 80)} empty=${badgeEmpty}`);
    evidence.viewport390.branchScoped = scoped;
  } catch (error) {
    log("390 主流程", false, error instanceof Error ? error.message : String(error));
    await page.screenshot({ path: join(ART, "enrollment_website_390_fail.png"), fullPage: true }).catch(() => undefined);
  } finally {
    await ctx.close();
  }
}

{
  const wide = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await wide.newPage();
  try {
    await createRoom(page, "招生樹寬屏");
    await openEnrollmentBoard(page);
    await page.getByTestId("wb-start-enrollment-tree").click();
    await page.waitForSelector('[data-testid="wb-tree-child"][data-tree-label="書籤"], [data-enrollment-label="書籤"]', { timeout: 10000 });
    await clickTreeChild(page, "書籤");
    await page.waitForSelector('[data-testid="wb-tree-path"]', { timeout: 8000 });
    const pathText = (await page.getByTestId("wb-tree-path").first().textContent()) ?? "";
    log("寬屏也看得到 202609招生 › 書籤", pathText.includes("書籤"), pathText);
    await page.screenshot({ path: join(ART, "enrollment_website_tree_wide_1024.png"), fullPage: false });
    evidence.viewportWide.treePath = pathText.trim();
  } catch (error) {
    log("寬屏", false, error instanceof Error ? error.message : String(error));
  } finally {
    await wide.close();
  }
}

{
  await fetch(`${CONTROL}/next-join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "reviewer" }),
  }).catch(() => undefined);
  const rev = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_UA,
  });
  const page = await rev.newPage();
  try {
    if (!inviteUrl) throw new Error("no invite url captured");
    await page.goto(inviteUrl, { waitUntil: "domcontentloaded" });
    await page.fill("input.text-input", "檢視夥伴");
    await page.click("button.btn-primary");
    await page.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 30000 });
    await page.getByRole("button", { name: "白板", exact: true }).click();
    const create = page.getByRole("button", { name: "建立白板" });
    const canCreateBoard = await create.count();
    if (canCreateBoard) {
      await page.getByLabel("白板名稱").fill("不該種樹");
      await create.click();
    }
    await page.waitForTimeout(800);
    const plant = page.getByTestId("wb-start-enrollment-tree");
    const emptyPlant = page.getByTestId("wb-empty-plant-enrollment-tree");
    if (await plant.count()) {
      await plant.click();
    } else if (await emptyPlant.count()) {
      await emptyPlant.click();
    }
    await page.waitForTimeout(800);
    const notice = (await page.getByTestId("wb-notice").textContent().catch(() => "")) ?? "";
    const children = await page.locator('[data-testid="wb-tree-child"]').count();
    const blocked = notice.includes("檢視者") || children === 0;
    log("reviewer 不能種樹", blocked, notice || `children=${children} createBoard=${canCreateBoard}`);
    await page.screenshot({ path: join(ART, "enrollment_website_reviewer_no_plant_390.png"), fullPage: false });
    evidence.reviewer.blocked = blocked;
    evidence.reviewer.notice = notice;
  } catch (error) {
    log("reviewer", false, error instanceof Error ? error.message : String(error));
    await page.screenshot({ path: join(ART, "enrollment_reviewer_fail.png"), fullPage: true }).catch(() => undefined);
  } finally {
    await rev.close();
  }
}

await browser.close();
writeFileSync(join(ART, "enrollment_website_browser_notes.json"), `${JSON.stringify({
  at: evidence.at,
  url: APP,
  notes,
  evidence: {
    ...evidence,
    inviteCaptured: Boolean(inviteUrl),
  },
}, null, 2)}\n`);
const failed = notes.filter((item) => !item.pass);
process.exit(failed.length ? 1 : 0);
