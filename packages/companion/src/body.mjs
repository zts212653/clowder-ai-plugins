// F336 Phase C: the living body page. The Host-owned preload provides `clowderCompanion`; outside
// the Host the page stays empty rather than pretending to be connected.
import { createBodyHostClient } from './living-world/host-client.mjs';
import { mount } from './living-world/world.mjs';

if (window.clowderCompanion) {
  mount(document.getElementById('world'), createBodyHostClient({ bridge: window.clowderCompanion }));
}
