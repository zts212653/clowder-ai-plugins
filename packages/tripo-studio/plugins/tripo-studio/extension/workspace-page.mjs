// Injected as a fixed function into the authorized workspace. No caller code,
// selectors, credentials, framework internals or private HTTP APIs are accepted.
export async function workspacePage(command) {
  const text = (e) => (e?.innerText ?? '').replace(/\s+/g, ' ').trim();
  const visible = (e) =>
    !!e &&
    e.getBoundingClientRect().width > 0 &&
    e.getBoundingClientRect().height > 0;
  const all = (selector, root = document) =>
    [...root.querySelectorAll(selector)].filter(visible);
  const unique = (values) => {
    if (values.length !== 1) throw new Error('STUDIO_UI_CHANGED');
    return values[0];
  };
  const click = (e) => {
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = e.getBoundingClientRect(),
      hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (
      !hit ||
      !e.contains(hit) ||
      e.disabled ||
      e.getAttribute('aria-disabled') === 'true'
    )
      throw new Error('UI_CONTROL_BLOCKED');
    e.click();
  };
  const button = (label, root = document) =>
    unique(all('button', root).filter((e) => text(e) === label));
  const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
  const wait = async (find) => {
    for (let i = 0; i < 25; i++) {
      const result = find();
      if (result) return result;
      await pause();
    }
    throw new Error('STUDIO_UI_NOT_READY');
  };
  const panel = () =>
    all('[data-workspace-panel]').find((e) =>
      all('h2', e).some((h) => text(h) === 'Generate Model'),
    );
  const loggedIn = !all('button').some((e) =>
    /^(Sign up\/Log in|登录|注册\/登录)$/.test(text(e)),
  );
  const modelIds = () => [
    ...new Set(
      all('a[href]')
        .map(
          (e) =>
            e.href.match(
              /\/3d-model\/[^/?]*?([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/,
            )?.[1],
        )
        .filter(Boolean),
    ),
  ];
  const privacy = () => {
    const label = all('p', panel()).find((e) => text(e) === 'Privacy');
    return text(label?.parentElement?.querySelector('[role=combobox]'));
  };
  const quantity = () => {
    const choices = all('button[aria-pressed=true]', panel()).filter((e) =>
      ['1', '2', '4'].includes(text(e)),
    );
    return choices.length === 1 ? Number(text(choices[0])) : null;
  };
  const snapshot = () => {
    const p = panel();
    const generate =
      p && all('button', p).find((e) => /^Generate\s+\d+$/.test(text(e)));
    return {
      pageUrl: location.href,
      loggedIn,
      kind: p ? 'generation' : location.pathname.split('/').at(-1),
      privacy: p ? privacy() : null,
      model: p ? text(all('[role=combobox]', p).at(-1)) : null,
      generationLabel: text(generate),
      creditCost: generate ? Number(text(generate).match(/(\d+)$/)[1]) : null,
      canSubmit: !!generate && !generate.disabled,
      quantity: quantity(),
      imageSlots: p
        ? all('input[type=file]', p).map((e) => ({
            label: text(e.parentElement).slice(0, 120),
            accept: e.accept,
          }))
        : [],
      controls: p
        ? all('button,[role=combobox],[role=switch]', p)
            .map((e) => ({
              text: text(e).slice(0, 160),
              role: e.getAttribute('role'),
              checked: e.getAttribute('aria-checked'),
              disabled: e.disabled ?? false,
            }))
            .filter((e) => e.text || e.role)
        : [],
      modelIds: modelIds(),
      visibleInfo: (p ? text(p) : text(document.querySelector('main'))).slice(
        0,
        5000,
      ),
      observedAt: new Date().toISOString(),
    };
  };
  if (command.kind === 'inspect') return snapshot();
  if (!loggedIn) throw new Error('TRIPO_NOT_LOGGED_IN');
  if (['configure', 'upload-file', 'submit'].includes(command.kind) && !panel())
    throw new Error('OPEN_GENERATION_WORKSPACE');
  if (command.kind === 'configure') {
    let p = panel();
    if (!p) throw new Error('OPEN_GENERATION_WORKSPACE');
    click(button(command.mode, p));
    await pause();
    p = panel();
    click(
      unique(
        all('button', p).filter((e) =>
          e.querySelector(
            `[class~="i-tripo:${command.views === 4 ? 'multi-view' : 'add-image'}"]`,
          ),
        ),
      ),
    );
    await wait(() => all('input[type=file]', panel()).length === command.views);
    if (command.mode === 'Smart Mesh') {
      click(button('1', panel()));
      await wait(() => quantity() === 1);
    }
    const current = privacy();
    if (current !== command.privacy) {
      const label = unique(
        all('p', panel()).filter((e) => text(e) === 'Privacy'),
      );
      click(unique(all('[role=combobox]', label.parentElement)));
      const option = await wait(() =>
        all('[role=option]').find((e) => text(e) === command.privacy),
      );
      click(option);
      await wait(() => privacy() === command.privacy);
    }
    if (command.topology !== undefined || command.polycount !== undefined) {
      if (command.mode !== 'Smart Mesh')
        throw new Error('HD_TOPOLOGY_NOT_IMPLEMENTED');
      click(unique(all('p', panel()).filter((e) => text(e) === 'Topology')));
      const dialog = await wait(() =>
        all('[role=dialog]').find((e) => text(e).startsWith('Topology')),
      );
      if (command.topology)
        click(
          unique(
            all('button', dialog).filter(
              (e) => text(e).replace(/ New$/, '') === command.topology,
            ),
          ),
        );
      if (command.polycount) {
        const field = unique(all('input[type=text]', dialog));
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        ).set.call(field, String(command.polycount));
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        await pause();
        if (field.value !== String(command.polycount))
          throw new Error('SETTINGS_NOT_APPLIED');
      }
      const topology = text(all('button[aria-pressed=true]', dialog)[0]);
      const polycount = all('input[type=text]', dialog)[0]?.value;
      if (command.topology && !topology.startsWith(command.topology))
        throw new Error('SETTINGS_NOT_APPLIED');
      click(
        unique(
          all('button', dialog).filter((e) => !text(e) && e.type === 'button'),
        ),
      );
      const state = snapshot();
      return {
        ...state,
        topology: topology.replace(/ New$/, ''),
        polycount: Number(polycount),
      };
    }
    return snapshot();
  }
  if (command.kind === 'upload-file') {
    const inputs = all('input[type=file]', panel());
    const names = ['front', 'left', 'right', 'back'];
    const index =
      inputs.length === 1 && command.view === 'front'
        ? 0
        : names.indexOf(command.view);
    if (index < 0 || !inputs[index]) throw new Error('IMAGE_SLOT_MISSING');
    const bytes = Uint8Array.from(atob(command.data), (c) => c.charCodeAt(0));
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    ]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
    if (hash !== command.sha256) throw new Error('IMAGE_DIGEST_MISMATCH');
    const files = new DataTransfer();
    files.items.add(new File([bytes], command.name, { type: command.mime }));
    inputs[index].files = files.files;
    inputs[index].dispatchEvent(new Event('change', { bubbles: true }));
    await pause();
    return {
      view: command.view,
      sha256: hash,
      dispatched: true,
      ...snapshot(),
    };
  }
  if (command.kind === 'submit') {
    const p = panel();
    if (!p || !privacy()) throw new Error('STUDIO_UI_CHANGED');
    const generate = unique(
      all('button', p).filter((e) => /^Generate\s+\d+$/.test(text(e))),
    );
    if (quantity() !== 1) throw new Error('SINGLE_GENERATION_NOT_VERIFIED');
    if (generate.disabled) throw new Error('GENERATION_NOT_READY');
    const before = modelIds();
    click(generate);
    await pause();
    const fresh = modelIds().filter((id) => !before.includes(id));
    return {
      receipt: fresh.length === 1 ? { modelId: fresh[0] } : null,
      ...snapshot(),
    };
  }
  if (command.kind === 'export') {
    // Only the selected model's visible identifier or page URL is evidence of identity.
    if (
      ![...new URL(location.href).searchParams.values()].includes(
        command.modelId,
      )
    )
      throw new Error('SELECTED_MODEL_UNVERIFIED');
    const exports = all('button').filter((e) => /^Export$/.test(text(e)));
    if (exports.length === 1) click(exports[0]);
    const dialog = await wait(() =>
      all('[role=dialog]').find((e) => /Export/i.test(text(e))),
    );
    const formats = all('button,[role=option]', dialog).filter(
      (e) => text(e).toLowerCase() === command.format,
    );
    if (formats.length !== 1) throw new Error('EXPORT_FORMAT_UNVERIFIED');
    click(formats[0]);
    await pause();
    // Export menus vary: a single exact action is required, never a generic click.
    const download = unique(
      all('button', dialog).filter((e) => /^(Download|Export)$/.test(text(e))),
    );
    if (download.disabled) throw new Error('EXPORT_NOT_READY');
    click(download);
    return {
      requested: true,
      modelId: command.modelId,
      format: command.format,
    };
  }
  throw new Error('INVALID_PAGE_OPERATION');
}
