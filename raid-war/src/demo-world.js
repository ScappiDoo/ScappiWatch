// Two small test nations, used by the tests, the demo and `--demo` seeding.
const grid = (x0, x1, y0, y1) => { const t = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) t.push([x, y]); return t; };

export function seedDemoWorld(world, { homeWindow = 0, members = 5 } = {}) {
  world.addNation({ id: 'vik', tiles: grid(20, 39, 40, 49), capital: [20, 40], treasury: 1000, spawns: [{ x: 21.5, y: 45.5 }] });
  world.addNation({
    id: 'sax', tiles: grid(40, 59, 40, 49), capital: [59, 49], treasury: 2000, homeWindow,
    spawns: [{ x: 58.5, y: 45.5 }, { x: 58.5, y: 46.5 }, { x: 58.5, y: 44.5 }],
  });
  for (let i = 1; i <= members; i++) {
    world.addMember('vik', { id: `v${i}`, rank: i === 1 ? 'leader' : 'member', ip: `10.0.0.${i}` });
    world.addMember('sax', { id: `s${i}`, rank: i === 1 ? 'leader' : 'member', ip: `10.0.1.${i}` });
  }
}
