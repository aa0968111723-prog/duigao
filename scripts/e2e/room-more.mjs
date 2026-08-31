/** Open the first-layer 更多 sheet if secondary chrome is not visible. */
export async function ensureRoomMore(page) {
  const sheet = page.getByTestId("room-more-sheet");
  if (await sheet.count()) return;
  await page.getByTestId("room-more").click();
  await page.waitForSelector('[data-testid="room-more-sheet"]', { timeout: 8000 });
}

export async function openRoomPane(page, testId) {
  await ensureRoomMore(page);
  await page.getByTestId(testId).click();
}

export async function openRoomCreate(page) {
  const sheet = page.getByTestId("create-content-sheet");
  if (await sheet.count()) return;
  await ensureRoomMore(page);
  // 平板 Split View 時討論「送出」是 position:fixed z-index 30，會蓋住
  // 更多 sheet 裡的 FAB（z-index 25）。點的是已打開的更多列，不是穿透討論。
  await page.getByTestId("room-more-sheet").getByTestId("room-add-content").click({ force: true });
  await page.waitForSelector('[data-testid="create-content-sheet"]', { timeout: 15000 });
}
