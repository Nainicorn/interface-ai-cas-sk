/**
 * The HTTP status of the document currently on screen.
 *
 * A legacy target states its runtime faults twice: once in the status line, once in the
 * page it renders. MERIDIAN CORE returns 503 with SCHEDULED MAINTENANCE IN PROGRESS, 440
 * with SESSION HAS TIMED OUT, 403 with SUPERVISOR OVERRIDE REQUIRED. The status is the
 * better of the two to classify on — it cannot be matched by accident the way a phrase
 * can, it does not move when the copy is reworded, and it is the same across every
 * screen the fault can land on.
 *
 * Playwright throws that information away once navigation settles, so it is captured as
 * it goes past. Only main-frame document responses count: a stray 404 on a missing
 * favicon says nothing about the page a person is looking at.
 *
 * Kept in a WeakMap rather than on the page object so nothing is mutated that Playwright
 * owns, and so a closed page's entry goes away with it.
 *
 * Hands off to: engine/perception.js (the http_status condition), engine/replay.js.
 */

/** @type {WeakMap<import('playwright').Page, number>} */
const LAST_STATUS = new WeakMap();

/**
 * Every document status this page has shown, not just the most recent one.
 *
 * A fault does not always stay on screen. This host answers an expired session with 440
 * and then sends the browser to the sign-on page, so by the time a step fails its
 * checkpoint the status reads 200 and the 440 is gone. Asking "was the session ever
 * dropped during this run" needs the history; asking "what is on screen now" needs the
 * last one. Both questions are real, so both are kept.
 *
 * @type {WeakMap<import('playwright').Page, Set<number>>}
 */
const STATUSES_SEEN = new WeakMap();

/**
 * Start recording main-frame document statuses for a page. Idempotent per page.
 * Called once wherever a page is created — replay and discovery both.
 */
export function trackDocumentStatus(page) {
  if (LAST_STATUS.has(page)) return page;
  // Seeded so a page that has not navigated yet reads as "nothing observed" rather than
  // as undefined, which a condition would have to special-case.
  LAST_STATUS.set(page, 0);
  STATUSES_SEEN.set(page, new Set());

  page.on('response', (response) => {
    const request = response.request();
    if (request.resourceType() !== 'document') return;
    if (request.frame() !== page.mainFrame()) return;
    // A redirect is not the page anyone ends up on; the status that matters is the one
    // the browser actually rendered.
    if (response.status() >= 300 && response.status() < 400) return;
    LAST_STATUS.set(page, response.status());
    STATUSES_SEEN.get(page)?.add(response.status());
  });

  return page;
}

/** The last main-frame document status seen on this page; 0 if none has been observed. */
export const lastDocumentStatus = (page) => LAST_STATUS.get(page) ?? 0;

/** Whether this page ever rendered a document with the given status. */
export const sawDocumentStatus = (page, status) => STATUSES_SEEN.get(page)?.has(status) ?? false;
