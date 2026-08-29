/** Open GAP-04 更多 before touching secondary chrome (chips / AI / share / FAB). */
export async function openRoomMore(page) {
  if (await page.getByTestId("room-more-sheet").count()) return;
  await page.getByTestId("room-more").click();
  await page.waitForSelector('[data-testid="room-more-sheet"]', { timeout: 8000 });
}
