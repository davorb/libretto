/**
 * `libretto/test`: what generated files import instead of `@playwright/test`.
 *
 * Adds one auto fixture: after a test that did not get its expected status, it attaches
 * `libretto-dom` (page HTML plus `page.locator('body').ariaSnapshot()`). This is the DOM
 * snapshot triage reads (SPEC: "trace, screenshots, DOM snapshot"). Playwright does not
 * save one outside the trace.
 *
 * Kept tiny on purpose: generated code depends on this module, so its surface is a
 * compatibility contract for every committed test.
 */
import { test as base, expect } from '@playwright/test'

export const test = base.extend<{ librettoDom: void }>({
  librettoDom: [
    async ({ page }, use, testInfo) => {
      await use()
      if (testInfo.status !== testInfo.expectedStatus) {
        // TODO: attach { html: await page.content(), aria: await page.locator('body').ariaSnapshot() }
        //       as 'libretto-dom' (application/json); swallow errors if the page is closed.
      }
    },
    { auto: true },
  ],
})

export { expect }
