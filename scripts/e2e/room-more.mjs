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
  await page.getByTestId("room-add-content").click();
  await page.waitForSelector('[data-testid="create-content-sheet"]', { timeout: 15000 });
}
