import { expect } from '@playwright/test'

import { comfyPageFixture as test } from '@e2e/fixtures/ComfyPage'

test.describe('Workflow tab switch serialization', () => {
  test.beforeEach(async ({ comfyPage }) => {
    await comfyPage.settings.setSetting(
      'Comfy.Workflow.WorkflowTabsPosition',
      'Topbar'
    )
    await comfyPage.setup()
  })

  test('snapshots the outgoing graph once for a normal tab click', async ({
    comfyPage
  }) => {
    const topbar = comfyPage.menu.topbar

    await topbar.newWorkflowButton.click()
    await expect.poll(() => topbar.getTabNames()).toHaveLength(2)

    await comfyPage.page.evaluate(() => {
      const rootGraph = window.app!.rootGraph
      const originalSerialize = rootGraph.serialize.bind(rootGraph)
      document.documentElement.dataset.workflowSwitchSerializeCount = '0'

      rootGraph.serialize = () => {
        const count = Number(
          document.documentElement.dataset.workflowSwitchSerializeCount ?? '0'
        )
        document.documentElement.dataset.workflowSwitchSerializeCount = String(
          count + 1
        )
        return originalSerialize()
      }
    })

    await topbar.getTab(0).click()
    await expect(topbar.getActiveTab()).toContainText('Unsaved Workflow')
    await expect(topbar.getActiveTab()).not.toContainText('(2)')

    const serializeCount = await comfyPage.page.evaluate(() =>
      Number(
        document.documentElement.dataset.workflowSwitchSerializeCount ?? '-1'
      )
    )

    expect(serializeCount).toBe(1)
  })
})
