import { expect } from '@playwright/test'

import type { ComfyPage } from '@e2e/fixtures/ComfyPage'
import { comfyPageFixture as test } from '@e2e/fixtures/ComfyPage'
import { recordMeasurement } from '@e2e/fixtures/utils/perfReporter'

type StageTiming = {
  count: number
  totalMs: number
  maxMs: number
}

type StageTimings = Record<string, StageTiming>

type InstrumentedGlobal = typeof globalThis & {
  __workflowSwitchTimings?: StageTimings
}

async function installSwitchInstrumentation(comfyPage: ComfyPage) {
  await comfyPage.page.evaluate(() => {
    const global = globalThis as InstrumentedGlobal
    const timings: StageTimings = {}
    global.__workflowSwitchTimings = timings

    const record = (name: string, durationMs: number) => {
      const timing = timings[name] ?? { count: 0, totalMs: 0, maxMs: 0 }
      timing.count++
      timing.totalMs += durationMs
      timing.maxMs = Math.max(timing.maxMs, durationMs)
      timings[name] = timing
    }

    const instrumentSync = (target: object, key: string, name: string) => {
      const recordTarget = target as Record<string, unknown>
      const original = recordTarget[key]
      if (typeof original !== 'function') return

      recordTarget[key] = function (this: unknown, ...args: unknown[]) {
        const start = performance.now()
        try {
          return original.apply(this, args)
        } finally {
          record(name, performance.now() - start)
        }
      }
    }

    const instrumentAsync = (target: object, key: string, name: string) => {
      const recordTarget = target as Record<string, unknown>
      const original = recordTarget[key]
      if (typeof original !== 'function') return

      recordTarget[key] = async function (this: unknown, ...args: unknown[]) {
        const start = performance.now()
        try {
          return await original.apply(this, args)
        } finally {
          record(name, performance.now() - start)
        }
      }
    }

    const app = window.app!
    instrumentAsync(app, 'loadGraphData', 'loadGraphData')
    instrumentSync(app, 'clean', 'clean')
    instrumentSync(app.rootGraph, 'configure', 'rootGraph.configure')
    instrumentSync(app.rootGraph, 'serialize', 'rootGraph.serialize')
    instrumentSync(app.rootGraph, 'clear', 'rootGraph.clear')
    instrumentSync(HTMLCanvasElement.prototype, 'toDataURL', 'canvas.toDataURL')
    instrumentSync(Storage.prototype, 'getItem', 'storage.getItem')
    instrumentSync(Storage.prototype, 'setItem', 'storage.setItem')
  })
}

async function resetStageTimings(comfyPage: ComfyPage) {
  await comfyPage.page.evaluate(() => {
    const global = globalThis as InstrumentedGlobal
    global.__workflowSwitchTimings = {}
  })
}

async function getStageTimings(comfyPage: ComfyPage): Promise<StageTimings> {
  return await comfyPage.page.evaluate(() => {
    const global = globalThis as InstrumentedGlobal
    return global.__workflowSwitchTimings ?? {}
  })
}

async function measureTabSwitch(
  comfyPage: ComfyPage,
  tabIndex: number,
  label: string
) {
  await resetStageTimings(comfyPage)
  await comfyPage.perf.startMeasuring()

  const start = await comfyPage.page.evaluate(() => performance.now())
  await comfyPage.menu.topbar.getTab(tabIndex).click()
  await comfyPage.workflow.waitForWorkflowIdle(10_000)
  await comfyPage.nextFrame()
  await comfyPage.nextFrame()
  const end = await comfyPage.page.evaluate(() => performance.now())

  const measurement = await comfyPage.perf.stopMeasuring(label)
  recordMeasurement(measurement)
  const timings = await getStageTimings(comfyPage)
  const wallMs = end - start

  console.log(
    `${label}: wall=${wallMs.toFixed(1)}ms, task=${measurement.taskDurationMs.toFixed(1)}ms, TBT=${measurement.totalBlockingTimeMs.toFixed(1)}ms, layouts=${measurement.layouts}, layoutDuration=${measurement.layoutDurationMs.toFixed(1)}ms, styleRecalcs=${measurement.styleRecalcs}, DOM=${measurement.domNodes}`
  )
  console.log(`${label} stages: ${JSON.stringify(timings)}`)

  return { measurement, timings, wallMs }
}

async function setupLargeAndBlankTabs(comfyPage: ComfyPage, vueNodes: boolean) {
  await comfyPage.settings.setSetting(
    'Comfy.Workflow.WorkflowTabsPosition',
    'Topbar'
  )
  await comfyPage.settings.setSetting('Comfy.VueNodes.Enabled', vueNodes)
  await comfyPage.workflow.loadWorkflow('large-graph-workflow')
  await comfyPage.menu.topbar.newWorkflowButton.click()
  await expect.poll(() => comfyPage.menu.topbar.getTabNames()).toHaveLength(2)
  await comfyPage.workflow.waitForWorkflowIdle(10_000)
  await comfyPage.nextFrame()
}

test.describe('Workflow switch performance diagnosis', { tag: ['@perf'] }, () => {
  for (const vueNodes of [false, true]) {
    const renderer = vueNodes ? 'vue' : 'legacy'

    test(`${renderer}: blank -> 245-node workflow -> blank`, async ({
      comfyPage
    }) => {
      await setupLargeAndBlankTabs(comfyPage, vueNodes)
      await installSwitchInstrumentation(comfyPage)

      const intoLarge = await measureTabSwitch(
        comfyPage,
        0,
        `workflow-switch-${renderer}-blank-to-large`
      )
      expect(intoLarge.wallMs).toBeGreaterThan(0)

      const intoBlank = await measureTabSwitch(
        comfyPage,
        1,
        `workflow-switch-${renderer}-large-to-blank`
      )
      expect(intoBlank.wallMs).toBeGreaterThan(0)
    })
  }
})
