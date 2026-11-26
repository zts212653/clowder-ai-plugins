/*
 * This component supplies the Host's resolved presentation tokens to the
 * sandboxed HTML. The existing frame renderer delivers them on load and update.
 */
(function () {
  function themeMessage() {
    const page = document.documentElement;
    const theme = getComputedStyle(page);
    const tokens = {
      '--canvas': '--bg-page',
      '--surface-1': '--bg-page',
      '--surface-2': '--bg-group',
      '--surface-3': '--bg-field',
      '--hairline': '--line',
      '--hairline-strong': '--line-strong',
      '--ink': '--ink',
      '--body': '--fg',
      '--muted': '--fg-muted',
      '--primary': '--accent',
      '--primary-active': '--accent-hover',
      '--primary-soft': '--accent-soft',
      '--on-primary': '--fg-on-accent',
      '--success': '--ok',
      '--warning': '--warn',
      '--critical': '--danger',
      '--info': '--accent-fg',
      '--sans': '--font-text',
      '--serif': '--font-display',
      '--mono': '--font-mono',
    };
    const colors = Object.fromEntries(
      Object.entries(tokens).map(([local, host]) => [local, theme.getPropertyValue(host).trim()]),
    );
    const mode = page.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    return { type: 'storage-governance.theme', mode, colors };
  }

  PDL_COMPONENTS['plugin:official.storage-governance/themed-frame'] = function (props, scope, root) {
    return pvBlocks([{ type: 'frame', html: props.html, title: props.title, message: themeMessage() }], scope, root);
  };

  onRender(function () {
    const frame = document.querySelector('iframe[data-frame-key="storageGovernance.page"]:not([inert] *)');
    if (!frame) return;
    // A palette switch can update only the Host root styles without redrawing this view.
    const message = JSON.stringify(themeMessage());
    if (frame.getAttribute('data-frame-message') === message) return;
    frame.setAttribute('data-frame-message', message);
    frameMessage(frame);
  });
})();
