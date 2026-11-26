'use strict';

(function () {
  const popup = PDL_VIEWS['chat.pop']?.blocks.find(block => block.type === 'pop');
  const projects = popup?.blocks.find(block => block.blocks?.some(child => child.id === 'ppProj'));
  const search = popup?.blocks.find(block => block.items?.some(item => item.id === 'pp-path'));
  if (!projects || !search) return;

  const [browse, lobby, existing] = projects.item.nodes[''];
  projects.item.nodes[''] = [
    { ...existing, item: { ...existing.item, sub: undefined } },
    { ...lobby, sub: undefined },
    { ...browse, icon: 'plus', name: 't:dshProjects.add' },
  ];
  search.items.find(item => item.id === 'pp-path').value = '$.browse.query';
  popup.blocks.splice(popup.blocks.indexOf(search) + 1, 0, {
    type: 'text',
    variant: 'meta',
    when: '$.browse.root',
    text: { t: 'dshProjects.location', args: ['$.browse.root'] },
  });

  const openPage = A.popPage;
  A.popPage = function (data) {
    if (CS.pop?.kind === 'projPick' && data.v === 'browse') {
      CS.f['pp-path'] = '';
      CS.pop.stack = ['main'];
    }
    return openPage(data);
  };

  const popupModel = VM.chatPop;
  VM.chatPop = function () {
    const model = popupModel();
    if (!model?.browse) return model;
    const query = CS.f['pp-path'] || '';
    return {
      ...model,
      from: { kind: 'projPick', subpage: 'main' },
      browse: { ...model.browse, query, completions: query.trim() ? model.browse.completions : [] },
    };
  };

  const completePath = INPUTS.cafePathComplete;
  INPUTS.cafePathComplete = function (event) {
    if (event.target.value.trim()) return completePath(event);
    CS.f['pp-path'] = event.target.value;
    render(true);
  };

  const goToPath = FORMS.cafePathGo;
  FORMS.cafePathGo = async function () {
    if (!val('pp-path').trim() || !await goToPath()) return;
    CS.f['pp-path'] = '';
    render(true);
  };
})();
