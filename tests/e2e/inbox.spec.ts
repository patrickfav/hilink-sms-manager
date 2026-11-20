import { expect, test } from '@playwright/test'

const sms = {
  id: '6e2293394d5dc4e654afae3b517fa3ea',
  threadId: 'thread-example',
  sender: '+43 660 1234567',
  text: 'Your verification code is 482913.',
  receivedAt: '2026-11-14T12:00:00Z',
  read: false,
  isOtp: true,
  otpCodes: ['482913'],
}

test('login, inspect an OTP, and delete its SMS', async ({ page, context }) => {
  let deleted = false
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({ json: { authenticated: false } }),
  )
  await page.route('**/api/auth/login', (route) => route.fulfill({ json: { authenticated: true } }))
  await page.route('**/api/auth/logout', (route) =>
    route.fulfill({ json: { authenticated: false } }),
  )
  await page.route('**/api/sms', (route) =>
    route.fulfill({
      json: {
        messages: deleted ? [] : [sms],
        status: { connected: true, lastSync: sms.receivedAt, messageCount: deleted ? 0 : 1 },
      },
    }),
  )
  await page.route(`**/api/sms/${sms.id}`, (route) => {
    if (route.request().method() === 'DELETE') {
      deleted = true
      return route.fulfill({ status: 204, body: '' })
    }
    return route.fulfill({ json: sms })
  })

  await page.goto('/')
  await page.getByLabel('Username').fill('operator')
  await page.getByLabel('Password').fill('test-password')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.locator('.page-heading h1')).toContainText('Your inbox')
  await page.getByRole('button', { name: /\+43 660 1234567/ }).click()
  await expect(page.locator('.thread-message-text')).toHaveText('Your verification code is 482913.')
  await expect(page.getByText('482913', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Copy verification code 482913' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('482913')

  await page.getByRole('button', { name: 'Delete message' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete message' }).click()
  await expect(page.getByText('Your inbox is clear')).toBeVisible()
  expect(deleted).toBe(true)
})

test('inbox layout fits a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({ json: { authenticated: true } }),
  )
  await page.route('**/api/sms', (route) =>
    route.fulfill({
      json: { messages: [], status: { connected: true, lastSync: null, messageCount: 0 } },
    }),
  )
  await page.goto('/')
  await expect(page.getByText('Your inbox is clear')).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  )
  expect(overflow).toBe(false)
})
