'use strict';

(function () {
  const draw = pvRow;
  pvRow = function (template, row, root, listId) {
    const result = draw(template, row, root, listId);
    if (template !== 'live.run') return result;
    if (row.actions?.cmd) return { ...result, act: 'execOpen', data: argAttrs({ k: row.key }) };
    return row.actions?.inv
      ? { ...result, act: 'runOpen', data: argAttrs({ k: row.actions.inv }) }
      : result;
  };

  const drawHome = PANELS.home;
  PANELS.home = function () {
    const activity = homeModels().live;
    if (!activity.runs.length) return drawHome();
    const section = PDL_BLOCKS.section({
      title: 't:wsLive.live',
      label: '$.count',
      blocks: [{ type: 'list', id: 'dsh-home-live', from: '$.runs', row: 'live.run' }]
    }, activity, activity);
    return '<div class="dsh-home-live">' + section + '</div>' + drawHome();
  };
})();