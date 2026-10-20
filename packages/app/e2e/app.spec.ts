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

/** Opens an app bar menu (File, Export, ...) unless it is already open, and returns it. */
async function openMenu(page: Page, name: string) {
  const trigger = page.getByRole('button', { name, exact: true });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  const menu = page.getByRole('menu', { name });
  await expect(menu).toBeVisible();
  return menu;
}

/** Runs a command from an app bar menu, e.g. File → Open…. */
async function menuAction(page: Page, menu: string, item: string | RegExp) {
  await (await openMenu(page, menu)).getByRole('menuitem', { name: item }).click();
}

const canvasNode = (page: Page, label: string) =>
  page.locator('.react-flow__node').filter({ hasText: label });

/** Clicks a node and waits until it shows as selected, as a person would see before typing. */
async function selectNode(page: Page, label: string) {
  const node = canvasNode(page, label);
  await node.click();
  await expect(node).toHaveClass(/selected/);
}

test.beforeEach(async ({ page }) => {
  // Start in English unless a test switched language (survives reloads within a test).
  await page.addInitScript(() => {
    if (!localStorage.getItem('opsdraw:language')) localStorage.setItem('opsdraw:language', 'en');
  });
});

test.describe('smoke', () => {
  test('fits the whole diagram into the canvas at laptop size', async ({ page }) => {
    // The desktop app opens at 1280x760, where the canvas pane is narrow.
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto('/');
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    const pane = (await page.locator('.react-flow').boundingBox())!;
    await expect
      .poll(async () => {
        const boxes = await page
          .locator('.react-flow__node')
          .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect));
        return boxes.every(
          (b) =>
            b.left >= pane.x - 1 &&
            b.top >= pane.y - 1 &&
            b.right <= pane.x + pane.width + 1 &&
            b.bottom <= pane.y + pane.height + 1,
        );
      })
      .toBe(true);
  });

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
    const tile = page.locator('.palette .tile[title="Firewall"]');
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
      'service firewall(lucide:brick-wall)[Firewall]',
    );
  });

  test('editing a label in the inspector rewrites the file', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, SIMPLE);
    await selectNode(page, 'Web');
    const label = page.locator('.inspector label', { hasText: 'Label' }).locator('input');
    await label.fill('Storefront');
    await expect(page.locator('.cm-content')).toContainText(
      'service web(server)[Storefront] in vpc',
    );
  });

  test('deleting a node removes it and its connections', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, SIMPLE);
    await selectNode(page, 'Orders DB');
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
  async function readDownload(page: Page, item: string) {
    const download = page.waitForEvent('download');
    await menuAction(page, 'Export', item);
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
      await menuAction(page, 'File', 'Open…');
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
    await menuAction(page, 'File', 'Open…');
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
    await menuAction(page, 'File', /Import infrastructure/);
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
    // Direction is scoped to the app root, so the editor can be embedded in another page.
    const app = page.locator('.app');
    await expect(app).toHaveAttribute('dir', 'rtl');
    await expect(app).toHaveAttribute('lang', 'he');
    await expect(page.locator('html')).toHaveAttribute('lang', 'he');
    expect(await page.locator('html').getAttribute('dir')).toBeNull();
    await expect(page.locator('.editor-code')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('.canvas')).toHaveAttribute('dir', 'ltr');
    // The palette sits on the right in right-to-left layouts, the inspector on the left.
    const palette = (await page.locator('.palette').boundingBox())!;
    const inspector = (await page.locator('.inspector').boundingBox())!;
    expect(palette.x).toBeGreaterThan(inspector.x);
    // Menus are translated too.
    const exportMenu = await openMenu(page, 'ייצוא');
    await expect(exportMenu.getByRole('menuitem', { name: 'ייצוא SVG' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(exportMenu).toBeHidden();
    await page.reload();
    await expect(app).toHaveAttribute('dir', 'rtl');
    await page.getByRole('combobox', { name: 'שפה' }).selectOption('en');
    await expect(app).toHaveAttribute('dir', 'ltr');
  });

  test.describe('on a Hebrew system', () => {
    test.use({ locale: 'he-IL' });

    test('starts in English until the user picks a language', async ({ page }) => {
      // Undo the suite's English seed so the app sees a first launch on a Hebrew system.
      await page.addInitScript(() => localStorage.removeItem('opsdraw:language'));
      await page.goto('/');
      expect(await page.evaluate(() => navigator.language)).toBe('he-IL');
      const app = page.locator('.app');
      await expect(app).toHaveAttribute('lang', 'en');
      await expect(app).toHaveAttribute('dir', 'ltr');
      await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
    });

    test('ignores a language auto-saved by 0.1.3 and earlier, but remembers a real choice', async ({
      page,
    }) => {
      await page.addInitScript(() => {
        localStorage.removeItem('opsdraw:language');
        // What older versions stored after detecting the system language.
        if (!sessionStorage.getItem('seeded')) {
          localStorage.setItem('opsdraw:lang', 'he');
          sessionStorage.setItem('seeded', '1');
        }
      });
      await page.goto('/');
      const app = page.locator('.app');
      await expect(app).toHaveAttribute('lang', 'en');
      // Picking a language is saved and survives a reload.
      await page.getByRole('combobox', { name: 'Language' }).selectOption('de');
      await expect(app).toHaveAttribute('lang', 'de');
      expect(await page.evaluate(() => localStorage.getItem('opsdraw:language'))).toBe('de');
    });
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
  await selectNode(page, 'Alpha');
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
    // Keep the box inside the canvas: just outside it are the pane dividers and the editor, and
    // how close the nodes sit to the edge depends on the platform's font metrics.
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    const left = Math.max(Math.min(...boxes.map((b) => b.x)) - 20, pane.x + 4);
    const top = Math.max(Math.min(...boxes.map((b) => b.y)) - 20, pane.y + 4);
    const right = Math.min(
      Math.max(...boxes.map((b) => b.x + b.width)) + 20,
      pane.x + pane.width - 4,
    );
    const bottom = Math.min(
      Math.max(...boxes.map((b) => b.y + b.height)) + 20,
      pane.y + pane.height - 4,
    );
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
    await selectNode(page, 'Alpha');
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

test.describe('edge routes', () => {
  test('auto-layout stores routes, the canvas draws them, and moving a node drops its routes', async ({
    page,
  }) => {
    await page.goto('/');
    await expect.poll(() => editorDoc(page)).toMatch(/%% @route \w+ \w+ /);
    const doc = await editorDoc(page);
    const routes = [...doc.matchAll(/%% @route (\w+) (\w+) ((?:-?\d+,-?\d+ ?)+)/g)].map((m) => ({
      from: m[1]!,
      to: m[2]!,
      first: m[3]!.split(' ')[0]!.replace(',', ' '),
    }));
    expect(routes.length).toBeGreaterThan(0);

    // Routed edges use the custom edge, drawn through the stored bend points.
    const routed = page.locator('.react-flow__edge-routed');
    await expect(routed).toHaveCount(routes.length);
    const paths = await routed
      .locator('path.react-flow__edge-path')
      .evaluateAll((ps) => ps.map((p) => p.getAttribute('d') ?? ''));
    for (const r of routes) expect(paths.some((d) => d.includes(`L${r.first}`))).toBe(true);

    // Moving one end of a routed edge drops that edge's route, and only routes touching it.
    const moved = routes[0]!.from;
    const node = page.locator(`.react-flow__node[data-id="${moved}"]`);
    const box = (await node.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 34, { steps: 6 });
    await page.mouse.up();
    const stale = routes.filter((r) => r.from === moved || r.to === moved);
    for (const r of stale)
      await expect.poll(() => editorDoc(page)).not.toContain(`%% @route ${r.from} ${r.to} `);
    const after = await editorDoc(page);
    expect(after).toMatch(new RegExp(`%% @pos ${moved} `));
    for (const r of routes.filter((x) => !stale.includes(x)))
      expect(after).toContain(`%% @route ${r.from} ${r.to} `);
    await expect(routed).toHaveCount(routes.length - stale.length);
  });
});

test.describe('colors and legend', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
  });

  test('a swatch in the inspector writes %% @style and colors the group on the canvas', async ({
    page,
  }) => {
    await page.goto('/');
    await setEditorText(page, SIMPLE);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await canvasNode(page, 'VPC').locator('.arch-group-title').click();
    await page.locator('.inspector').getByRole('button', { name: 'Teal' }).click();
    await expect.poll(() => editorDoc(page)).toContain('%% @style vpc fill=teal stroke=teal');
    const group = page.locator('.react-flow__node[data-id="vpc"] .arch-group');
    await expect(group).toHaveCSS('border-top-color', 'rgb(13, 148, 136)');
    await expect(page.locator('.inspector').getByRole('button', { name: 'Teal' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Several nodes at once.
    await selectNode(page, 'Web');
    await canvasNode(page, 'Orders DB').click({ modifiers: ['Shift'] });
    await expect(page.locator('.inspector h2')).toHaveText('2 selected');
    await page.locator('.inspector').getByRole('button', { name: 'Orange' }).click();
    await expect.poll(() => editorDoc(page)).toContain('%% @style web fill=orange stroke=orange');
    expect(await editorDoc(page)).toContain('%% @style db fill=orange stroke=orange');
    await expect(page.locator('.react-flow__node[data-id="web"] .arch-service')).toHaveCSS(
      'border-top-color',
      'rgb(234, 88, 12)',
    );

    // Reset removes the line.
    await canvasNode(page, 'VPC').locator('.arch-group-title').click();
    await page.locator('.inspector').getByRole('button', { name: 'Default color' }).click();
    await expect.poll(() => editorDoc(page)).not.toContain('%% @style vpc');
  });

  test('typed styles that are not allowed colors are ignored', async ({ page }) => {
    await page.goto('/');
    await setEditorText(
      page,
      SIMPLE + '  %% @style vpc fill=red;background:url(javascript:alert(1)) stroke=#ff0000\n',
    );
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    const group = page.locator('.react-flow__node[data-id="vpc"] .arch-group');
    await expect(group).toHaveCSS('border-top-color', 'rgb(255, 0, 0)');
    const style = (await group.getAttribute('style')) ?? '';
    expect(style).not.toContain('javascript');
  });

  test('SVG export adds a legend when asked', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, SIMPLE + '  %% @style vpc fill=purple stroke=purple\n');
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    const exportSvg = async () => {
      const download = page.waitForEvent('download');
      await menuAction(page, 'Export', 'Export SVG');
      const file = await download;
      const chunks: Buffer[] = [];
      for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    };
    const plain = await exportSvg();
    expect(plain).not.toContain('class="legend"');
    expect(plain).toContain('var(--pal-purple-stroke)');

    const legend = (await openMenu(page, 'Export')).getByRole('menuitemcheckbox', {
      name: 'Legend',
    });
    await expect(legend).not.toBeChecked();
    await legend.click();
    // Check boxes keep the menu open, so several can be toggled.
    await expect(legend).toBeChecked();
    const svg = await exportSvg();
    expect(svg).toContain('class="legend"');
    expect(svg).toContain('>Legend</text>');
    // Icons used once are listed by their node's label (VPC's cloud), the color by its group.
    expect(svg).toContain('>Orders DB</text>');
    expect(svg.split('>VPC</text>').length - 1).toBe(3);
  });
});

const KINKED = `architecture-beta
  service api(server)[API]
  service queue(lucide:list-ordered)[Queue]
  service worker(server)[Worker]
  api:B -[enqueue]-> L:queue
  queue:R --> L:worker
  %% @pos api 40 40
  %% @pos queue 320 200
  %% @pos worker 560 200
  %% @route api queue 88,248
`;

/** The y of every point of an edge's drawn path. */
const pathYs = (d: string) => [...d.matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((m) => Number(m[2]));

test.describe('straight edges', () => {
  test('aligning two nodes re-picks the sides of the edge between them, so it is straight', async ({
    page,
  }) => {
    await page.goto('/');
    await setEditorText(page, KINKED);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(page.locator('.react-flow__edge-routed')).toHaveCount(1);
    await selectNode(page, 'API');
    await canvasNode(page, 'Queue').click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Align middle' }).click();
    await expect.poll(() => editorDoc(page)).toContain('api:R -[enqueue]-> L:queue');
    const doc = await editorDoc(page);
    expect(doc).not.toContain('@route api queue');
    // The other edge had no moved end and keeps its sides.
    expect(doc).toContain('queue:R --> L:worker');
    const d = await page
      .locator('.react-flow__edge')
      .filter({ hasText: 'enqueue' })
      .locator('path.react-flow__edge-path')
      .getAttribute('d');
    const ys = pathYs(d ?? '');
    expect(ys.length).toBeGreaterThan(1);
    expect(new Set(ys).size).toBe(1);
  });
});

test.describe('duplicate, copy and paste', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('Ctrl+D duplicates a node with a new id, offset, and selects the copy', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, PLACED);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await selectNode(page, 'Alpha');
    await page.keyboard.press('ControlOrMeta+D');
    await expect.poll(() => editorDoc(page)).toContain('service a2(server)[Alpha]');
    expect(await editorDoc(page)).toContain('%% @pos a2 64 64');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.react-flow__node.selected')).toHaveAttribute('data-id', 'a2');
    // The inspector's button does the same.
    await page.locator('.inspector').getByRole('button', { name: 'Duplicate' }).click();
    await expect.poll(() => editorDoc(page)).toContain('service a3(server)[Alpha]');
    expect(await editorDoc(page)).toContain('%% @pos a3 88 88');
  });

  test('duplicating a group copies its children and the edges inside it', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, SIMPLE);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await canvasNode(page, 'VPC').locator('.arch-group-title').click();
    await page.keyboard.press('ControlOrMeta+D');
    await expect.poll(() => editorDoc(page)).toContain('group vpc2(cloud)[VPC]');
    const doc = await editorDoc(page);
    expect(doc).toContain('service web2(server)[Web] in vpc2');
    expect(doc).toContain('service db2(database)[Orders DB] in vpc2');
    expect(doc).toContain('web2:R --> L:db2');
    await expect(page.locator('.react-flow__node')).toHaveCount(6);
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  });

  test('copy and paste through the system clipboard, at the pointer, as one undo step', async ({
    page,
  }) => {
    await page.goto('/');
    await setEditorText(page, PLACED);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await selectNode(page, 'Alpha');
    await page.keyboard.press('ControlOrMeta+C');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('service a(server)[Alpha]');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('%% @pos a 0 0');

    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    await page.mouse.move(pane.x + pane.width - 160, pane.y + pane.height - 160);
    await page.keyboard.press('ControlOrMeta+V');
    await expect.poll(() => editorDoc(page)).toContain('service a2(server)[Alpha]');
    await expect(page.locator('.react-flow__node')).toHaveCount(4);
    await expect(page.locator('.react-flow__node.selected')).toHaveAttribute('data-id', 'a2');
    // Pasted where the pointer is (within a few pixels: positions are whole canvas units).
    const pasted = (await page.locator('.react-flow__node[data-id="a2"]').boundingBox())!;
    expect(Math.abs(pasted.x - (pane.x + pane.width - 160))).toBeLessThan(8);
    expect(Math.abs(pasted.y - (pane.y + pane.height - 160))).toBeLessThan(8);

    await page.keyboard.press('ControlOrMeta+Z');
    await expect.poll(() => editorDoc(page)).not.toContain('a2');
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
  });

  test('pasting into the code editor keeps the native behaviour', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, PLACED);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await selectNode(page, 'Gamma');
    await page.keyboard.press('ControlOrMeta+C');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('service c(disk)[Gamma]');
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ControlOrMeta+V');
    await expect.poll(() => editorDoc(page)).toContain('%% @pos c 0 0');
    // The text went into the editor, not onto the canvas as a new node.
    expect(await editorDoc(page)).not.toContain('c2');
  });

  test('cut removes the selection and paste brings it back', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, PLACED);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await selectNode(page, 'Beta');
    await page.keyboard.press('ControlOrMeta+X');
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await expect.poll(() => editorDoc(page)).not.toContain('service b(');
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 120);
    await page.keyboard.press('ControlOrMeta+V');
    await expect.poll(() => editorDoc(page)).toContain('service b(database)[Beta]');
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
  });
});

test.describe('icon names', () => {
  test('curated icons have readable, translated names', async ({ page }) => {
    await page.goto('/');
    const palette = page.locator('.palette');
    await expect(palette.locator('.tile[title="Firewall"]')).toBeVisible();
    await expect(palette.locator('.tile[title="Load balancer"]')).toBeVisible();
    await expect(palette.locator('.tile[title="Shield"]')).toHaveCount(0);
    await palette.getByRole('searchbox').fill('firewall');
    await expect(palette.locator('.tile').first()).toHaveAttribute('title', 'Firewall');

    await page.getByRole('combobox', { name: 'Language' }).selectOption('he');
    await palette.getByRole('searchbox').fill('');
    await expect(palette.locator('.tile[title="חומת אש"]')).toBeVisible();
    // Searching in the UI language finds it too.
    await palette.getByRole('searchbox').fill('חומת אש');
    await expect(palette.locator('.tile').first()).toHaveAttribute('title', 'חומת אש');
  });

  test('on-prem storage icons are in the palette and found by their keywords', async ({ page }) => {
    await page.goto('/');
    const palette = page.locator('.palette');
    for (const title of ['Disk array', 'SAN', 'NAS', 'Tape library'])
      await expect(palette.locator(`.tile[title="${title}"]`)).toBeVisible();
    const search = palette.getByRole('searchbox');
    for (const [query, title] of [
      ['raid', 'Disk array'],
      ['fibre channel', 'SAN'],
      ['truenas', 'NAS'],
      ['lto', 'Tape library'],
    ] as const) {
      await search.fill(query);
      await expect(palette.locator('.tile').first()).toHaveAttribute('title', title);
    }
  });
});

test.describe('app bar, command palette and theme', () => {
  test('File and Export menus work from the keyboard', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    const file = page.getByRole('button', { name: 'File', exact: true });
    await file.focus();
    await page.keyboard.press('Enter');
    const fileMenu = page.getByRole('menu', { name: 'File' });
    await expect(fileMenu).toBeVisible();
    await expect(file).toHaveAttribute('aria-expanded', 'true');
    const items = fileMenu.getByRole('menuitem');
    await expect(items).toHaveText(['New', /Open…/, /Save/, /Save as…/, 'Import infrastructure…']);
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.nth(4)).toBeFocused();
    // Wraps around, and Home goes back to the top.
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(items.nth(4)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items.nth(0)).toBeFocused();
    // A letter jumps to the next item starting with it.
    await page.keyboard.press('s');
    await expect(items.nth(2)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(fileMenu).toBeHidden();
    await expect(file).toBeFocused();
    await expect(file).toHaveAttribute('aria-expanded', 'false');

    // Arrow Up opens on the last item; Space toggles a check box and keeps the menu open.
    const exportButton = page.getByRole('button', { name: 'Export', exact: true });
    await exportButton.focus();
    await page.keyboard.press('ArrowUp');
    const legend = page.getByRole('menuitemcheckbox', { name: 'Legend' });
    await expect(legend).toBeFocused();
    await expect(legend).not.toBeChecked();
    await page.keyboard.press(' ');
    await expect(legend).toBeChecked();
    // Enter on an item runs it and closes the menu.
    await page.keyboard.press('Home');
    const download = page.waitForEvent('download');
    await page.keyboard.press('Enter');
    expect((await download).suggestedFilename()).toBe('untitled.svg');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(exportButton).toBeFocused();

    // A click outside closes an open menu.
    await exportButton.click();
    await expect(page.getByRole('menu', { name: 'Export' })).toBeVisible();
    await page.locator('.statusbar').click();
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('menus open toward the inside edge in right-to-left layouts', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('he');
    const trigger = page.getByRole('button', { name: 'קובץ', exact: true });
    await trigger.click();
    const button = (await trigger.boundingBox())!;
    // Lined up with the trigger's right edge, so it opens leftwards, into the window. Polled,
    // because the short open animation can still be running when the menu first appears.
    await expect
      .poll(async () => {
        const menu = (await page.getByRole('menu', { name: 'קובץ' }).boundingBox())!;
        return Math.abs(menu.x + menu.width - (button.x + button.width));
      })
      .toBeLessThan(2);
    const menu = (await page.getByRole('menu', { name: 'קובץ' }).boundingBox())!;
    expect(menu.x).toBeGreaterThan(0);
  });

  test('Ctrl+K opens the command palette; "export svg" + Enter downloads the SVG', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.cm-content')).toContainText('%% @pos api');
    await page.locator('.statusbar').click();
    await page.keyboard.press('ControlOrMeta+K');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('combobox');
    await expect(input).toBeFocused();
    await input.fill('export svg');
    const first = dialog.getByRole('option').first();
    await expect(first).toHaveText('Export SVG');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!);
    const download = page.waitForEvent('download');
    await page.keyboard.press('Enter');
    const file = await download;
    expect(file.suggestedFilename()).toBe('untitled.svg');
    await expect(dialog).toBeHidden();

    // Escape closes it without running anything.
    await page.keyboard.press('ControlOrMeta+K');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('the command palette is fuzzy and adds palette icons to the canvas', async ({ page }) => {
    await page.goto('/');
    await setEditorText(page, SIMPLE);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await page.locator('.statusbar').click();
    await page.keyboard.press('ControlOrMeta+K');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    const input = dialog.getByRole('combobox');
    // Letters in order match too ("fwl" finds Firewall).
    await input.fill('add fwl');
    await expect(dialog.getByRole('option').first()).toHaveText('Add Firewall');
    await page.keyboard.press('Enter');
    await expect(page.locator('.react-flow__node')).toHaveCount(4);
    await expect(page.locator('.cm-content')).toContainText('service firewall(lucide:brick-wall)');
    await expect(page.locator('.react-flow__node.selected')).toHaveAttribute('data-id', 'firewall');

    // Arrow keys move the active option.
    await page.keyboard.press('ControlOrMeta+K');
    await input.fill('auto layout');
    const options = dialog.getByRole('option');
    await expect(options).toHaveCount(2);
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await input.fill('zzzzqqq');
    await expect(dialog).toContainText('No matching commands');
  });

  test('the theme choice switches to dark mode and survives a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    const html = page.locator('html');
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const light = await background();
    await expect(html).not.toHaveAttribute('data-theme');

    await page.getByRole('button', { name: 'Theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    const dark = await background();
    expect(dark).not.toBe(light);
    // The body really is dark: low lightness in OKLCH.
    expect(Number(/oklch\(([\d.]+)/.exec(dark)?.[1] ?? 1)).toBeLessThan(0.3);
    await expect(page.locator('.react-flow')).toHaveClass(/dark/);

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await background()).toBe(dark);
    await page.getByRole('button', { name: 'Theme' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeChecked();

    // "System" follows the operating system again.
    await page.getByRole('menuitemradio', { name: 'System' }).click();
    await expect(html).not.toHaveAttribute('data-theme');
    expect(await background()).toBe(light);
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await background()).toBe(dark);
  });

  test('keyboard focus shows a visible focus ring, mouse clicks do not', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    const file = page.getByRole('button', { name: 'File', exact: true });
    const ring = () =>
      file.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor };
      });

    // Open and close the menu with the mouse: the button gets focus back, without a ring.
    await file.click();
    await expect(page.getByRole('menu', { name: 'File' })).toBeVisible();
    await file.click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(file).toBeFocused();
    expect((await ring()).style).toBe('none');

    // Tabbing to it from the brand (the element before it) shows the ring.
    await page.locator('.brand').click();
    await page.keyboard.press('Tab');
    await expect(file).toBeFocused();
    const focused = await ring();
    expect(focused.style).toBe('solid');
    expect(focused.width).toBe('2px');
  });
});

test.describe('resizable panels', () => {
  const pane = (page: Page, id: 'palette' | 'editor' | 'inspector') => page.locator(`#pane-${id}`);
  const splitter = (page: Page, name: string) => page.getByRole('separator', { name, exact: true });
  const widthOf = async (page: Page, id: 'palette' | 'editor' | 'inspector') =>
    (await pane(page, id).boundingBox())!.width;

  /** Drags a splitter by dx/dy pixels with the mouse, in small steps like a person would. */
  async function drag(page: Page, name: string, dx: number, dy = 0) {
    const box = (await splitter(page, name).boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + Math.min(box.height / 2, 200);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
  }

  /** View → Code editor beside / above the canvas. */
  const editorPosition = async (page: Page, where: 'beside' | 'above') =>
    (await openMenu(page, 'View'))
      .getByRole('menuitemradio', { name: `Code editor ${where} the canvas` })
      .click();

  /** True when every node of the diagram is drawn inside the canvas. */
  const allNodesInCanvas = (page: Page) =>
    page.evaluate(() => {
      const pane = document.querySelector('.react-flow')!.getBoundingClientRect();
      return [...document.querySelectorAll('.react-flow__node')].every((el) => {
        const b = el.getBoundingClientRect();
        return (
          b.left >= pane.left - 1 &&
          b.top >= pane.top - 1 &&
          b.right <= pane.right + 1 &&
          b.bottom <= pane.bottom + 1
        );
      });
    });

  test('dragging the palette and editor splitters resizes them, and the sizes survive a reload', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    const palette = await widthOf(page, 'palette');
    const editor = await widthOf(page, 'editor');
    expect(palette).toBeCloseTo(224, 0);

    await drag(page, 'Resize palette', 80);
    await expect.poll(() => widthOf(page, 'palette')).toBeCloseTo(palette + 80, 0);
    await expect(splitter(page, 'Resize palette')).toHaveAttribute('aria-valuenow', '304');

    await drag(page, 'Resize code editor', -100);
    await expect.poll(() => widthOf(page, 'editor')).toBeCloseTo(editor - 100, 0);

    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    expect(await widthOf(page, 'palette')).toBeCloseTo(palette + 80, 0);
    expect(await widthOf(page, 'editor')).toBeCloseTo(editor - 100, 0);

    // A panel stops at its limits: the palette is 160-360px wide.
    await drag(page, 'Resize palette', 400);
    await expect.poll(() => widthOf(page, 'palette')).toBeCloseTo(360, 0);
    // Dragging well past the minimum collapses it to a rail.
    await drag(page, 'Resize palette', -320);
    await expect(pane(page, 'palette')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show palette' })).toBeVisible();
  });

  test('a focused splitter resizes with the arrow keys, Shift, Home and End', async ({ page }) => {
    await page.goto('/');
    const handle = splitter(page, 'Resize palette');
    await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    await expect(handle).toHaveAttribute('aria-controls', 'pane-palette');
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '240');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '304');
    await page.keyboard.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', '288');
    expect(await widthOf(page, 'palette')).toBeCloseTo(288, 0);
    await page.keyboard.press('Home');
    await expect(handle).toHaveAttribute('aria-valuenow', '160');
    await page.keyboard.press('End');
    await expect(handle).toHaveAttribute('aria-valuenow', '360');

    // The inspector is on the other side: moving its splitter left (toward the canvas) widens it.
    const inspector = splitter(page, 'Resize properties');
    await inspector.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(inspector).toHaveAttribute('aria-valuenow', '272');
    await expect.poll(() => widthOf(page, 'inspector')).toBeCloseTo(272, 0);
  });

  test('panels collapse and come back from the toggle buttons, rails, double-click, Enter and shortcuts', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    const toggle = page.getByRole('button', { name: 'Palette', exact: true });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(pane(page, 'palette')).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // The collapsed palette leaves a rail that brings it back at the same width.
    const rail = page.getByRole('button', { name: 'Show palette' });
    expect((await rail.boundingBox())!.width).toBeCloseTo(32, 0);
    await rail.click();
    await expect(pane(page, 'palette')).toBeVisible();
    expect(await widthOf(page, 'palette')).toBeCloseTo(224, 0);

    // Double-click a splitter to collapse its panel, and again to restore it.
    await splitter(page, 'Resize properties').dblclick();
    await expect(pane(page, 'inspector')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show properties' })).toBeVisible();
    await splitter(page, 'Resize properties').dblclick();
    await expect(pane(page, 'inspector')).toBeVisible();

    // Enter on a focused splitter does the same.
    await splitter(page, 'Resize code editor').focus();
    await page.keyboard.press('Enter');
    await expect(pane(page, 'editor')).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(pane(page, 'editor')).toBeVisible();

    // Keyboard shortcuts, also while typing in the code editor.
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Backslash');
    await expect(pane(page, 'editor')).toBeHidden();
    // Focus does not get lost on <body> when its panel goes away.
    await expect(page.locator('.canvas')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Backslash');
    await expect(pane(page, 'editor')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+b');
    await expect(pane(page, 'palette')).toBeHidden();
    await page.keyboard.press('ControlOrMeta+Period');
    await expect(pane(page, 'inspector')).toBeHidden();

    // Collapsed panels stay collapsed after a reload.
    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    await expect(pane(page, 'palette')).toBeHidden();
    await expect(pane(page, 'inspector')).toBeHidden();
    await expect(pane(page, 'editor')).toBeVisible();

    // The View menu shows and toggles them too.
    const view = await openMenu(page, 'View');
    const item = view.getByRole('menuitemcheckbox', { name: 'Properties' });
    await expect(item).toHaveAttribute('aria-checked', 'false');
    await item.click();
    await expect(pane(page, 'inspector')).toBeVisible();
    await expect(item).toHaveAttribute('aria-checked', 'true');
  });

  test('the command palette toggles panels and focus mode', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+K');
    await page.getByRole('combobox', { name: 'Command palette' }).fill('toggle code');
    await expect(
      page.getByRole('listbox', { name: 'Command palette' }).getByRole('option').first(),
    ).toContainText('Toggle code editor');
    await page.keyboard.press('Enter');
    await expect(pane(page, 'editor')).toBeHidden();

    await page.keyboard.press('ControlOrMeta+K');
    await page.getByRole('combobox', { name: 'Command palette' }).fill('focus canvas');
    await page.keyboard.press('Enter');
    await expect(pane(page, 'palette')).toBeHidden();
    await expect(pane(page, 'inspector')).toBeHidden();
  });

  test('the editor can sit above the canvas, with a row splitter between them', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    await editorPosition(page, 'above');
    await expect(page.locator('.workspace')).toHaveAttribute('data-editor', 'above');

    const editor = (await pane(page, 'editor').boundingBox())!;
    const stage = (await page.locator('.stage').boundingBox())!;
    // A vertical split: same column, editor on top.
    expect(editor.y + editor.height).toBeLessThanOrEqual(stage.y + 1);
    expect(editor.x).toBeCloseTo(stage.x, 0);
    expect(editor.width).toBeCloseTo(stage.width, 0);
    expect(editor.height).toBeCloseTo(240, 0);

    const row = splitter(page, 'Resize code editor');
    await expect(row).toHaveAttribute('aria-orientation', 'horizontal');
    await drag(page, 'Resize code editor', 0, 80);
    await expect
      .poll(async () => (await pane(page, 'editor').boundingBox())!.height)
      .toBeCloseTo(320, 0);
    await row.focus();
    await page.keyboard.press('ArrowUp');
    await expect(row).toHaveAttribute('aria-valuenow', '304');

    await page.reload();
    await expect(page.locator('.workspace')).toHaveAttribute('data-editor', 'above');
    expect((await pane(page, 'editor').boundingBox())!.height).toBeCloseTo(304, 0);

    // Collapsed above the canvas, the editor leaves a horizontal rail.
    await splitter(page, 'Resize code editor').dblclick();
    const rail = (await page.getByRole('button', { name: 'Show code editor' }).boundingBox())!;
    expect(rail.height).toBeCloseTo(32, 0);
    expect(rail.width).toBeGreaterThan(300);

    await editorPosition(page, 'beside');
    await expect(page.locator('.workspace')).toHaveAttribute('data-editor', 'beside');
  });

  test('focus mode hides every side panel and Esc brings them back', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    const before = (await page.locator('.react-flow').boundingBox())!;
    await page.keyboard.press('ControlOrMeta+Shift+F');
    for (const id of ['palette', 'editor', 'inspector'] as const)
      await expect(pane(page, id)).toBeHidden();
    await expect(page.locator('.pane-rail')).toHaveCount(0);
    await expect(page.getByRole('separator')).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('Esc');
    const focusButton = page.getByRole('button', { name: 'Focus canvas' });
    await expect(focusButton).toHaveAttribute('aria-pressed', 'true');
    // The canvas gets the whole width.
    await expect
      .poll(async () => (await page.locator('.react-flow').boundingBox())!.width)
      .toBeGreaterThan(before.width + 500);
    await expect.poll(() => allNodesInCanvas(page)).toBe(true);

    // It survives a reload, and Esc leaves it.
    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    await expect(pane(page, 'palette')).toBeHidden();
    await page.keyboard.press('Escape');
    for (const id of ['palette', 'editor', 'inspector'] as const)
      await expect(pane(page, id)).toBeVisible();
    await expect(page.getByRole('status')).not.toContainText('Esc');

    // The stage bar button toggles it too.
    await focusButton.click();
    await expect(pane(page, 'editor')).toBeHidden();
    await focusButton.click();
    await expect(pane(page, 'editor')).toBeVisible();
  });

  test('Reset layout restores the default sizes and panels', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    await drag(page, 'Resize palette', 60);
    await drag(page, 'Resize code editor', 90);
    await page.getByRole('button', { name: 'Properties', exact: true }).click();
    await editorPosition(page, 'above');
    await expect(pane(page, 'inspector')).toBeHidden();

    await menuAction(page, 'View', 'Reset layout');
    await expect(page.locator('.workspace')).toHaveAttribute('data-editor', 'beside');
    await expect(pane(page, 'inspector')).toBeVisible();
    expect(await widthOf(page, 'palette')).toBeCloseTo(224, 0);
    expect(await widthOf(page, 'editor')).toBeCloseTo(360, 0);
    expect(await widthOf(page, 'inspector')).toBeCloseTo(256, 0);
    await page.reload();
    expect(await widthOf(page, 'palette')).toBeCloseTo(224, 0);
  });

  test('in right-to-left layouts the panels mirror and dragging toward the canvas enlarges them', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('he');
    await expect(page.locator('.app')).toHaveAttribute('dir', 'rtl');
    const palette = (await pane(page, 'palette').boundingBox())!;
    const editor = (await pane(page, 'editor').boundingBox())!;
    const inspector = (await pane(page, 'inspector').boundingBox())!;
    expect(palette.x).toBeGreaterThan(editor.x);
    expect(editor.x).toBeGreaterThan(inspector.x);

    // The palette is on the right, so dragging its splitter left (inward) widens it.
    await drag(page, 'שינוי גודל לוח הרכיבים', -80);
    await expect.poll(() => widthOf(page, 'palette')).toBeCloseTo(304, 0);
    const box = (await pane(page, 'palette').boundingBox())!;
    expect(box.x + box.width).toBeCloseTo(palette.x + palette.width, 0);
    // Arrow keys follow the screen: ← moves the splitter left, which widens the palette here.
    const handle = splitter(page, 'שינוי גודל לוח הרכיבים');
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', '320');
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '304');
    // The inspector is on the left: dragging its splitter right widens it.
    await drag(page, 'שינוי גודל המאפיינים', 40);
    await expect.poll(() => widthOf(page, 'inspector')).toBeCloseTo(296, 0);
  });

  test('the canvas still fits the diagram after its panes are resized', async ({ page }) => {
    // The desktop app's default window size.
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto('/');
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    await expect.poll(() => allNodesInCanvas(page)).toBe(true);
    const before = (await page.locator('.react-flow').boundingBox())!.width;

    // A wider editor squeezes the canvas; it re-fits so nothing is cut off.
    await drag(page, 'Resize code editor', 120);
    await expect
      .poll(async () => (await page.locator('.react-flow').boundingBox())!.width)
      .toBeCloseTo(before - 120, 0);
    await expect.poll(() => allNodesInCanvas(page)).toBe(true);

    // The canvas never gets narrower than 280px, however far a splitter is dragged.
    await drag(page, 'Resize code editor', 600);
    expect((await page.locator('.react-flow').boundingBox())!.width).toBeGreaterThanOrEqual(279);
    await expect.poll(() => allNodesInCanvas(page)).toBe(true);

    await page.getByRole('button', { name: 'Palette', exact: true }).click();
    await page.getByRole('button', { name: 'Properties', exact: true }).click();
    await expect.poll(() => allNodesInCanvas(page)).toBe(true);
  });

  test('narrow windows start with the properties panel as a rail', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto('/');
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    await expect(pane(page, 'inspector')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show properties' })).toBeVisible();
    expect((await page.locator('.react-flow').boundingBox())!.width).toBeGreaterThanOrEqual(280);
    // Opening it squeezes the editor rather than the canvas.
    await page.getByRole('button', { name: 'Show properties' }).click();
    await expect(pane(page, 'inspector')).toBeVisible();
    expect((await page.locator('.react-flow').boundingBox())!.width).toBeGreaterThanOrEqual(279);
    // No horizontal scrolling.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      1000,
    );
  });
});
