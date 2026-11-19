// F336 Phase C: the living body page. The Host-owned preload provides `clowderCompanion`; outside
// the Host the page stays empty rather than pretending to be connected.
// The world data is a module the package build writes from world.json: the static surface allows no fetch.
import { createBodyHostClient } from './living-world/host-client.mjs';
import { mount } from './living-world/world.mjs';
import world from './skins/xianxian-living-world/world.mjs';

const ATLASES = [0, 1, 2].map(index => `./skins/xianxian-living-world/world-atlas-${index}.webp`);

if (window.clowderCompanion) {
  mount(document.getElementById('world'), createBodyHostClient({ bridge: window.clowderCompanion }), { data: world, atlasUrls: ATLASES });
}
