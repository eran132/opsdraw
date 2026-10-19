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

  test('the preview shows how GitHub and other Mermaid renderers will draw it', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Mermaid preview' }).click();
    await expect(page.getByTestId('preview-svg').locator('> svg')).toContainText('Jobs queue');
  });
});

test.describe('export', () => {
  async function readDownload(page: Page, button: string) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: button }).click();
    const file = await download;
    const chunks: Buffer[] = [];
    for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer);
    return { name: file.suggestedFilename(), bytes: Buffer.concat(chunks) };
  }

  test.beforeEach(async ({ page }) => {
    // Use the <input type=file> path so Playwright can choose files.
    await page.addInitScript(() => {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker;
    });
  });

  test('SVG and PNG exports match the canvas and reopen as the same diagram', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.cm-content')).toContainText('%% @pos api');
    const original = await page.evaluate(() =>
      [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n'),
    );

    const svg = await readDownload(page, 'Export SVG');
    expect(svg.name).toBe('untitled.svg');
    const svgText = svg.bytes.toString('utf8');
    expect(svgText).toMatch(/^<svg/);
    expect(svgText).not.toContain('foreignObject');
    expect(svgText).toContain('>Load balancer</text>');
    expect(svgText).toContain('<metadata id="opsdraw-source"');
    // Well-formed XML, as other tools (Inkscape, Confluence, Typora) need.
    const parseError = await page.evaluate(
      (t) =>
        new DOMParser().parseFromString(t, 'image/svg+xml').querySelector('parsererror')
          ?.textContent ?? null,
      svgText,
    );
    expect(parseError).toBeNull();

    const png = await readDownload(page, 'Export PNG');
    expect(png.name).toBe('untitled.png');
    // The PNG still decodes after the source chunk is inserted.
    const size = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      return { w: img.naturalWidth, h: img.naturalHeight };
    }, png.bytes.toString('base64'));
    expect(size.w).toBeGreaterThan(100);

    for (const f of [
      { name: 'diagram.svg', mimeType: 'image/svg+xml', buffer: svg.bytes },
      { name: 'diagram.png', mimeType: 'image/png', buffer: png.bytes },
    ]) {
      await setEditorText(page, 'architecture-beta\n');
      page.once('dialog', (d) => void d.accept());
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Open…' }).click();
      await (await chooser).setFiles(f);
      await expect(page.locator('.react-flow__node')).toHaveCount(9);
      await expect(page.locator('.file-name')).toContainText('diagram.mmd');
      // The editor updates one render after the canvas, so poll.
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n'),
          ),
        )
        .toBe(original);
    }
  });

  test('images without an embedded diagram are refused politely', async ({ page }) => {
    await page.goto('/');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Open…' }).click();
    await (
      await chooser
    ).setFiles({
      name: 'random.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    });
    await expect(page.locator('.statusbar')).toContainText('no embedded OpsDraw diagram');
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
  });
});

test.describe('infrastructure as code', () => {
  test('imports Terraform into nested groups', async ({ page }) => {
    await page.goto('/');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Import infrastructure/ }).click();
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

/** The whole editor text; CodeMirror only renders the lines in view. */
const editorDoc = (page: Page) =>
  page.evaluate(() => {
    type Doc = { state: { doc: { toString(): string } } };
    const content = document.querySelector('.cm-content') as
      (Element & { cmTile?: { root?: { view?: Doc } } }) | null;
    const view = content?.cmTile?.root?.view;
    if (view) return view.state.doc.toString();
    return [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n');
  });

const PLACED = `architecture-beta
  service a(server)[Alpha]
  service b(database)[Beta]
  service c(disk)[Gamma]
  %% @pos a 40 40
  %% @pos b 240 160
  %% @pos c 120 320
`;

async function selectAllThree(page: Page) {
  await canvasNode(page, 'Alpha').click();
  await canvasNode(page, 'Beta').click({ modifiers: ['Shift'] });
  await canvasNode(page, 'Gamma').click({ modifiers: ['Shift'] });
}

test.describe('arranging nodes', () => {
  test('shift-click selects several nodes and aligns their left edges', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, PLACED);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await selectAllThree(page);
    const inspector = page.locator('.inspector');
    await expect(inspector.locator('h2')).toHaveText('3 selected');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(3);
    await inspector.getByRole('button', { name: 'Align left' }).click();
    await expect.poll(() => editorDoc(page)).toContain('%% @pos b 40 160');
    const doc = await editorDoc(page);
    expect(doc).toContain('%% @pos a 40 40');
    expect(doc).toContain('%% @pos c 40 320');
  });

  test('shift-drag draws a selection box around several nodes', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, PLACED);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    const boxes = await Promise.all(
      ['Alpha', 'Beta', 'Gamma'].map(async (l) => (await canvasNode(page, l).boundingBox())!),
    );
    const left = Math.min(...boxes.map((b) => b.x)) - 20;
    const top = Math.min(...boxes.map((b) => b.y)) - 20;
    const right = Math.max(...boxes.map((b) => b.x + b.width)) + 20;
    const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 20;
    await page.keyboard.down('Shift');
    await page.mouse.move(left, top);
    await page.mouse.down();
    await page.mouse.move(right, bottom, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect(page.locator('.inspector h2')).toHaveText('3 selected');
  });

  test('distributes three nodes evenly and disables alignment across groups', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, PLACED);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await selectAllThree(page);
    await page.getByRole('button', { name: 'Distribute vertically' }).click();
    // Alpha (top) and Gamma (bottom) stay; Beta lands so both gaps are equal.
    await expect.poll(() => editorDoc(page)).not.toContain('%% @pos b 240 160');
    const doc = await editorDoc(page);
    expect(doc).toContain('%% @pos a 40 40');
    expect(doc).toContain('%% @pos c 120 320');
    // Same-sized boxes: Beta's top lands halfway between Alpha's and Gamma's.
    expect(doc).toContain('%% @pos b 240 180');

    await setEditorText(page, SIMPLE);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await canvasNode(page, 'VPC').locator('.arch-group-title').click();
    await canvasNode(page, 'Web').click({ modifiers: ['Shift'] });
    await expect(page.locator('.inspector h2')).toHaveText('2 selected');
    await expect(page.getByRole('button', { name: 'Align left' })).toBeDisabled();
    await expect(page.locator('.inspector')).toContainText('same group');
  });

  test('arrow keys nudge the selection by 8px, Shift by 1px, as one undo step', async ({
    page,
  }) => {
    await page.goto('/');
    await setEditorText(page, PLACED);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await canvasNode(page, 'Alpha').click();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => editorDoc(page)).toContain('%% @pos a 48 40');
    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(() => editorDoc(page)).toContain('%% @pos a 48 41');

    // A quick burst is committed once, so a single undo reverts all of it.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => editorDoc(page)).toContain('%% @pos a 32 33');
    await page.keyboard.press('ControlOrMeta+Z');
    await expect.poll(() => editorDoc(page)).toContain('%% @pos a 48 41');

    // Arrow keys in the editor move the cursor, not the node.
    await page.locator('.cm-content').click();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(600);
    expect(await editorDoc(page)).toContain('%% @pos a 48 41');
  });
});

test.describe('GitHub compatibility', () => {
  test('warns about pack icons and swaps in built-ins where it can', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.cm-content')).toContainText('%% @pos api');
    await page.getByRole('tab', { name: 'Mermaid preview' }).click();
    const hint = page.getByTestId('github-icons-hint');
    await expect(hint).toContainText('GitHub and GitLab draw only the built-in icons');
    await hint.getByRole('button', { name: 'Use built-in icons where possible' }).click();
    await expect.poll(() => editorDoc(page)).toContain('service cdn(internet)[CDN]');
    const doc = await editorDoc(page);
    // Icons with no close built-in are left alone, and positions are kept.
    expect(doc).toContain('service users(lucide:users)[Users]');
    expect(doc).toContain('%% @pos api');
    await expect(hint).toBeVisible();

    await setEditorText(page, SIMPLE);
    await expect(page.getByTestId('preview-svg').locator('> svg')).toContainText('Orders DB');
    await expect(hint).toHaveCount(0);
  });
});

test.describe('large diagrams', () => {
  test('a 500-service diagram renders and lays out without freezing the page', async ({ page }) => {
    test.setTimeout(180_000);
    const workers: string[] = [];
    page.on('worker', (w) => workers.push(w.url()));
    const groups = 25;
    const perGroup = 20;
    const total = groups * perGroup;
    const lines = ['architecture-beta'];
    for (let g = 0; g < groups; g++) lines.push(`  group g${g}(cloud)[Zone ${g}]`);
    for (let i = 0; i < total; i++)
      lines.push(`  service s${i}(server)[Service ${i}] in g${Math.floor(i / perGroup)}`);
    for (let i = 0; i < total; i++) {
      if (i % perGroup !== perGroup - 1) lines.push(`  s${i}:R --> L:s${i + 1}`);
      if (i % perGroup === 0 && i + perGroup < total)
        lines.push(`  s${i}:B --> T:s${i + perGroup}`);
    }

    await page.goto('/');
    await expect(page.locator('.cm-content')).toContainText('%% @pos api');
    await setEditorText(page, lines.join('\n') + '\n');
    await expect.poll(() => editorDoc(page)).toContain('service s499(server)[Service 499] in g24');
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    await expect(page.locator('.problems')).toHaveCount(0);

    // A timer that keeps ticking unless the main thread is blocked.
    await page.evaluate(() => {
      const w = window as unknown as { __maxGap: number; __last: number };
      w.__maxGap = 0;
      w.__last = performance.now();
      setInterval(() => {
        const now = performance.now();
        w.__maxGap = Math.max(w.__maxGap, now - w.__last);
        w.__last = now;
      }, 25);
    });
    const started = Date.now();
    await page.getByRole('button', { name: 'Auto layout →' }).click();
    await expect
      .poll(() => editorDoc(page), { timeout: 15_000 })
      .toMatch(/%% @pos s499 -?\d+ -?\d+\n/);
    const elapsed = Date.now() - started;
    const maxGap = await page.evaluate(() => (window as unknown as { __maxGap: number }).__maxGap);
    console.log(
      `500 services: layout ${elapsed} ms, longest main-thread stall ${Math.round(maxGap)} ms`,
    );
    expect(elapsed).toBeLessThan(15_000);
    // Drawing the result takes a moment, but the layout itself must not block the page.
    expect(maxGap).toBeLessThan(5_000);
    expect(workers.some((u) => u.includes('layout.worker'))).toBe(true);

    // Only what is in view is drawn once the diagram is this big.
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    expect(await page.locator('.react-flow__node').count()).toBeLessThan(total + groups);
  });
});
