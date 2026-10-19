import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';

const SIMPLE = `architecture-beta
  group vpc(cloud)[VPC]
  service web(server)[Web] in vpc
  service db(database)[Orders DB] in vpc
  web:R --> L:db
`;

async function setEditorText(page: Page, text: string) {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

const canvasNode = (page: Page, label: string) =>
  page.locator('.react-flow__node').filter({ hasText: label });

test.beforeEach(async ({ page }) => {
  // Start in English unless a test switched language (survives reloads within a test).
  await page.addInitScript(() => {
    if (!localStorage.getItem('opsdraw:lang')) localStorage.setItem('opsdraw:lang', 'en');
  });
});

test.describe('smoke', () => {
  test('loads the sample diagram without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto('/');
    await expect(page).toHaveTitle(/OpsDraw/);
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    await expect(canvasNode(page, 'Load balancer')).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(6);
    // The sample gets an automatic layout on start, written back as @pos lines.
    await expect(page.locator('.cm-content')).toContainText('%% @pos api');
    expect(errors).toEqual([]);
  });
});

test.describe('text and canvas stay in sync', () => {
  test('typing Mermaid updates the canvas', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, SIMPLE);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(canvasNode(page, 'Orders DB')).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });

  test('syntax errors are reported with line numbers and the canvas keeps the last good version', async ({
    page,
  }) => {
    await page.goto('/');
    await setEditorText(page, SIMPLE);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await page.keyboard.insertText('  oops this is wrong\n');
    await expect(page.locator('.problems')).toContainText('Line 6');
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
  });

  test('dropping an icon from the palette adds a service to the text', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, SIMPLE);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    const tile = page.locator('.palette .tile[title="List ordered"]');
    const pane = page.locator('.react-flow__pane');
    const box = (await pane.boundingBox())!;
    // Playwright's dragTo doesn't reliably drive HTML5 drag-and-drop onto the canvas, so the
    // real drag events are dispatched with a shared DataTransfer.
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await tile.dispatchEvent('dragstart', { dataTransfer });
    const at = { clientX: box.x + box.width - 80, clientY: box.y + box.height - 80 };
    await pane.dispatchEvent('dragover', { dataTransfer, ...at });
    await pane.dispatchEvent('drop', { dataTransfer, ...at });
    await expect(page.locator('.react-flow__node')).toHaveCount(4);
    await expect(page.locator('.cm-content')).toContainText(
      'service list_ordered(lucide:list-ordered)[List ordered]',
    );
  });

  test('editing a label in the inspector rewrites the file', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, SIMPLE);
    await canvasNode(page, 'Web').click();
    const label = page.locator('.inspector label', { hasText: 'Label' }).locator('input');
    await label.fill('Storefront');
    await expect(page.locator('.cm-content')).toContainText(
      'service web(server)[Storefront] in vpc',
    );
  });

  test('deleting a node removes it and its connections', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, SIMPLE);
    await canvasNode(page, 'Orders DB').click();
    await page.keyboard.press('Delete');
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    // The editor syncs one render after the canvas, so use retrying assertions.
    await expect(page.locator('.cm-content')).not.toContainText('service db');
    await expect(page.locator('.cm-content')).not.toContainText('--> L:db');
  });

  test('moving a service out of its group un-nests it', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, SIMPLE);
    const node = canvasNode(page, 'Web');
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    const from = (await node.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + 10);
    await page.mouse.down();
    await page.mouse.move(pane.x + pane.width - 60, pane.y + pane.height - 60, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.cm-content')).toContainText('service web(server)[Web]\n');
    await expect(page.locator('.cm-content')).not.toContainText('[Web] in vpc');
  });

  test('flowcharts can be converted into architecture diagrams', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, 'flowchart LR\n  a[Client] --> b[(Postgres)]\n');
    await page.getByRole('button', { name: 'Convert to architecture' }).click();
    await expect(page.locator('.cm-content')).toContainText('architecture-beta');
    await expect(page.locator('.cm-content')).toContainText('service b(database)[Postgres]');
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
  });
});

test.describe('mermaid compatibility', () => {
  test('the real Mermaid renderer draws the file', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Mermaid preview' }).click();
    // The diagram's root <svg>; Mermaid nests more <svg>s inside for icons.
    const svg = page.getByTestId('preview-svg').locator('> svg');
    await expect(svg).toBeVisible();
    await expect(svg).toContainText('Load balancer');
    await expect(page.locator('.preview-error')).toHaveCount(0);
  });

  test('exports an SVG', async ({ page }) => {
    await page.goto('/');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export SVG' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('untitled.svg');
    const stream = await file.createReadStream();
    let body = '';
    for await (const chunk of stream) body += chunk;
    expect(body).toMatch(/^<svg/);
  });
});

test.describe('infrastructure as code', () => {
  test('imports Terraform into nested groups', async ({ page }) => {
    await page.goto('/');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Import Terraform/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'main.tf',
      mimeType: 'text/plain',
      buffer: Buffer.from(`
        resource "aws_vpc" "main" {}
        resource "aws_subnet" "app" { vpc_id = aws_vpc.main.id }
        resource "aws_instance" "api" { subnet_id = aws_subnet.app.id }
        resource "aws_db_instance" "orders" { subnet = aws_subnet.app.id }
        resource "aws_lb" "public" { target = aws_instance.api.id }
      `),
    });
    await expect(page.locator('.react-flow__node')).toHaveCount(5);
    await expect(page.locator('.cm-content')).toContainText(
      'group app(lucide:network)[app] in main',
    );
    await expect(page.locator('.cm-content')).toContainText('service api(server)[api] in app');
    await expect(page.locator('.cm-content')).toContainText(
      'service orders(database)[orders] in app',
    );
  });
});

test.describe('internationalization', () => {
  test('Hebrew switches the UI to right-to-left and keeps code left-to-right', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('he');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'he');
    await expect(page.locator('.editor-code')).toHaveAttribute('dir', 'ltr');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});

test.describe('vendor icon packs', () => {
  test('imports a pack locally and strips active content', async ({ page }) => {
    const zip = new JSZip();
    zip.file(
      'Icons/48/Arch_Example-Service_48.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><script>window.__pwned=1</script>' +
        '<rect id="bg" width="48" height="48" fill="url(#g)" onload="window.__pwned=2"/></svg>',
    );
    zip.file(
      'Icons/16/Arch_Example-Service_16.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"/>',
    );
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    await page.goto('/');
    await page.getByRole('button', { name: 'Icon packs…' }).click();
    const dialog = page.locator('dialog');
    await dialog.locator('label', { hasText: 'Prefix' }).locator('input').fill('acme');
    await dialog
      .locator('input[type=file]')
      .setInputFiles({ name: 'acme.zip', mimeType: 'application/zip', buffer });
    const importButton = dialog.getByRole('button', { name: 'Import' });
    await expect(importButton).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await importButton.click();
    await expect(dialog).toContainText('Imported 1 icons as "acme:"');
    await dialog.getByRole('button', { name: 'Close' }).click();

    await page.locator('.palette-search').fill('example');
    const tile = page.locator('.palette .tile[title="Example service"]');
    await expect(tile).toBeVisible();
    expect(await tile.innerHTML()).not.toMatch(/script|onload/i);
    expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  });
});
