#!/usr/bin/env node

import { chromium } from 'playwright'
import { createServer } from 'vite'
import globby from 'globby'

const mode = process.env["MODE"]
const port = 9999


// Get Test File Paths

const files = await globby("./**/*.doc.mjs", { cwd: "./specs" })


// Serve Test Files

const server = await createServer({
  configFile: './specs/vite.config.js',
  server: {
    port
  }
})
await server.listen()


// Validate Test Files

const browser = await chromium.launch({
  headless: mode !== "debug"
})
const page = await browser.newPage()

page.on("console", console.log)
page.on("pageerror", console.log)

await page.goto(`http://localhost:${port}/index.html`)
await page.evaluate((files) => bdvp_run(files), files)

if (mode === "watch" || mode === "debug") {
  page.on("load", (page) => {
    page.evaluate((files) => bdvp_run(files), files)
  })
} else {
  await browser.close()
  await server.close()
}