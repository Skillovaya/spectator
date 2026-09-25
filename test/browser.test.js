const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap } = require('../spectator.user.js');

function makeCamera() {
  const number = value => ({ value, update_dleff0$(dt, next) { this.value = next; } });
  return {
    currState_0: { direction: 0 },
    pivot_0: {
      value: { x: 0, y: 0, z: 300 },
      update_sl07mc$(dt, target) { Object.assign(this.value, target); }
    },
    polarDistance_0: number(300),
    pitch_0: number(0),
    elevation_0: number(0.2)
  };
}

class FakeDocument extends EventTarget {
  constructor(camera) {
    super();
    const tank = { tag: 'LocalTank', components_0: { array: [{ followCamera_0: camera }] } };
    this.store = {
      state: { battleStatistics: { inBattle: () => true } },
      subscribers: { array: [{ tank }] }
    };
    this.rootElement = { _reactRootContainer: { _internalRoot: { current: {
      memoizedState: { element: { type: { prototype: { store: this.store } } } }
    } } } };
    this.documentElement = { appendChild: element => { this.panel = element; } };
    this.hidden = false;
    this.activeElement = null;
    this.pointerLockElement = null;
    this.status = { textContent: '', className: '' };
    this.button = new EventTarget();
    this.button.textContent = '';
    this.container = { classList: { toggle: () => {} } };
    this.logButton = new EventTarget();
    this.logButton.setAttribute = () => {};
    this.details = { hidden: true };
    this.logArea = {
      value: '', focus() { this.focused = true; }, select() { this.selected = true; }
    };
    this.copyButton = new EventTarget();
    this.copyStatus = { textContent: '' };
    const elements = {
      '.panel': this.container, '#status': this.status, '#toggle': this.button,
      '#show-logs': this.logButton, '#diagnostics': this.details,
      '#log': this.logArea, '#copy': this.copyButton, '#copy-status': this.copyStatus
    };
    this.shadow = { querySelector: selector => elements[selector] };
    this.canvas = {
      requestPointerLock: () => {
        this.pointerLockElement = this.canvas;
        this.dispatchEvent(new Event('pointerlockchange'));
        return Promise.resolve();
      }
    };
    this.exitPointerLock = () => {
      this.pointerLockElement = null;
      this.dispatchEvent(new Event('pointerlockchange'));
    };
  }

  getElementById(id) { return id === 'root' ? this.rootElement : null; }
  querySelector(selector) { return selector === 'canvas' ? this.canvas : null; }
  createElement() {
    const element = new EventTarget();
    element.style = {};
    element.attachShadow = () => this.shadow;
    return element;
  }
}

class FakeWindow extends EventTarget {
  constructor(doc) {
    super();
    this.document = doc;
    this.location = { hostname: 'tankionline.com' };
    this.copied = [];
    this.navigator = { clipboard: { writeText: async text => { this.copied.push(text); } } };
    this.consoleEntries = [];
    this.console = {
      info: (...args) => this.consoleEntries.push(['info', ...args]),
      warn: (...args) => this.consoleEntries.push(['warn', ...args]),
      error: (...args) => this.consoleEntries.push(['error', ...args])
    };
    this.frames = new Map();
    this.nextFrame = 0;
    this.requestAnimationFrame = callback => {
      const id = ++this.nextFrame;
      this.frames.set(id, callback);
      return id;
    };
    this.cancelAnimationFrame = id => this.frames.delete(id);
    this.setInterval = callback => { this.interval = callback; return 1; };
    this.clearInterval = () => { this.interval = null; };
  }

  frame(time) {
    const [id, callback] = this.frames.entries().next().value;
    this.frames.delete(id);
    callback(time);
  }
}

function send(win, name, properties = {}) {
  const event = new Event(name, { cancelable: true });
  Object.assign(event, properties);
  win.dispatchEvent(event);
  return event;
}

test('installed userscript blocks game movement, flies, releases lock and restores on F8', () => {
  const camera = makeCamera();
  const doc = new FakeDocument(camera);
  const win = new FakeWindow(doc);
  const originalPivot = camera.pivot_0.update_sl07mc$;
  bootstrap(win);
  assert.ok(doc.panel);
  const gameInputs = [];
  const gamePointers = [];
  win.addEventListener('keydown', event => gameInputs.push(event.code), true);
  win.addEventListener('pointermove', event => gamePointers.push(event.type), true);

  send(win, 'keydown', { code: 'KeyW' }); // Held before activating; game must see keyup.
  send(win, 'keydown', { code: 'F8' });
  assert.match(doc.status.textContent, /отпустите клавиши/);
  assert.equal(camera.pivot_0.update_sl07mc$, originalPivot);
  send(win, 'keyup', { code: 'KeyW' });

  send(win, 'keydown', { code: 'F8' });
  assert.match(doc.status.textContent, /откреплена/);
  const callsBeforeFlight = gameInputs.length;
  assert.equal(send(win, 'keydown', { code: 'KeyW' }).defaultPrevented, true);
  assert.equal(gameInputs.length, callsBeforeFlight);
  send(win, 'pointermove', { button: -1 });
  assert.equal(gamePointers.length, 0);
  win.frame(16);
  win.frame(32);
  assert.notEqual(camera.pivot_0.value.y, -300);
  assert.equal(send(win, 'wheel', { deltaY: -200 }).defaultPrevented, true);
  assert.match(doc.status.textContent, /ед\/с/);

  send(win, 'mousedown', { button: 2 });
  assert.equal(doc.pointerLockElement, doc.canvas);
  send(win, 'mousemove', { movementX: 50, movementY: 5 });
  assert.ok(camera.currState_0.direction < 0);
  send(win, 'mouseup', { button: 2 });
  assert.equal(doc.pointerLockElement, null);

  send(win, 'keyup', { code: 'KeyW' });
  send(win, 'keydown', { code: 'F8' });
  assert.equal(camera.pivot_0.update_sl07mc$, originalPivot);
  assert.equal(win.frames.size, 0);
  send(win, 'keydown', { code: 'KeyW' });
  assert.equal(gameInputs.at(-1), 'KeyW');
  win.dispatchEvent(new Event('pagehide'));
  assert.equal(win.interval, null);
});

test('changing battles restores the camera automatically', () => {
  const camera = makeCamera();
  const doc = new FakeDocument(camera);
  const win = new FakeWindow(doc);
  const originalPivot = camera.pivot_0.update_sl07mc$;
  bootstrap(win);
  doc.button.dispatchEvent(new Event('click'));
  assert.match(doc.status.textContent, /откреплена/);
  doc.store.state.battleStatistics.inBattle = () => false;
  win.interval();
  assert.equal(camera.pivot_0.update_sl07mc$, originalPivot);
  assert.equal(win.frames.size, 0);
  win.dispatchEvent(new Event('pagehide'));
});

test('red status persists and copy button returns a structural failure log', async () => {
  const camera = makeCamera();
  delete camera.pitch_0.update_dleff0$;
  const doc = new FakeDocument(camera);
  const win = new FakeWindow(doc);
  bootstrap(win);
  doc.button.dispatchEvent(new Event('click'));
  assert.match(doc.status.textContent, /CAMERA_INCOMPATIBLE/);
  assert.equal(doc.status.className, 'error');
  win.interval();
  assert.equal(doc.status.className, 'error');
  doc.logButton.dispatchEvent(new Event('click'));
  assert.equal(doc.details.hidden, false);
  assert.match(doc.logArea.value, /pitch_0\.update_dleff0\$/);
  doc.copyButton.dispatchEvent(new Event('click'));
  await new Promise(setImmediate);
  assert.equal(win.copied.length, 1);
  const log = JSON.parse(win.copied[0]);
  assert.equal(log.version, '0.2.0');
  assert.equal(log.host, 'tankionline.com');
  assert.ok(log.events.some(event => event.code === 'CAMERA_PROBE' &&
    event.details.trace.result === 'CAMERA_INCOMPATIBLE'));
  assert.match(doc.copyStatus.textContent, /скопирован/);
  win.dispatchEvent(new Event('pagehide'));
});

test('failed camera patch stays visible with its stage, and rollback restores methods', () => {
  const camera = makeCamera();
  const originalPivot = camera.pivot_0.update_sl07mc$;
  Object.defineProperty(camera.polarDistance_0, 'update_dleff0$', {
    value: camera.polarDistance_0.update_dleff0$, writable: false, configurable: false
  });
  const doc = new FakeDocument(camera);
  const win = new FakeWindow(doc);
  bootstrap(win);
  doc.button.dispatchEvent(new Event('click'));
  assert.match(doc.status.textContent, /ATTACH_FAILED/);
  assert.equal(camera.pivot_0.update_sl07mc$, originalPivot);
  win.interval();
  assert.equal(doc.status.className, 'error');
  doc.logButton.dispatchEvent(new Event('click'));
  const log = JSON.parse(doc.logArea.value);
  assert.ok(log.events.some(event => event.code === 'ATTACH_FAILED' &&
    event.details.stage === 'attachFreeCamera'));
  win.dispatchEvent(new Event('pagehide'));
});

test('a startup failure after patching still restores the camera', () => {
  const camera = makeCamera();
  const doc = new FakeDocument(camera);
  const win = new FakeWindow(doc);
  const original = camera.pivot_0.update_sl07mc$;
  win.requestAnimationFrame = () => { throw Error('rAF unavailable'); };
  bootstrap(win);
  doc.button.dispatchEvent(new Event('click'));
  assert.match(doc.status.textContent, /ATTACH_FAILED/);
  assert.equal(camera.pivot_0.update_sl07mc$, original);
  assert.equal(camera.polarDistance_0.value, 300);
  doc.logButton.dispatchEvent(new Event('click'));
  const log = JSON.parse(doc.logArea.value);
  assert.ok(log.events.some(event => event.code === 'ATTACH_FAILED' &&
    event.details.stage === 'activate'));
  win.dispatchEvent(new Event('pagehide'));
});

test('clipboard denial selects the visible log for manual copying', async () => {
  const doc = new FakeDocument(makeCamera());
  doc.rootElement = null;
  const win = new FakeWindow(doc);
  win.navigator.clipboard.writeText = async () => { throw Error('denied'); };
  bootstrap(win);
  doc.button.dispatchEvent(new Event('click'));
  assert.match(doc.status.textContent, /ROOT_MISSING/);
  doc.logButton.dispatchEvent(new Event('click'));
  doc.copyButton.dispatchEvent(new Event('click'));
  await new Promise(setImmediate);
  assert.equal(doc.logArea.selected, true);
  assert.match(doc.copyStatus.textContent, /Ctrl\+C/);
  assert.match(doc.logArea.value, /COPY_FALLBACK/);
  win.dispatchEvent(new Event('pagehide'));
});

test('polling and frame loop only log state changes and a single hook check', () => {
  const camera = makeCamera();
  const doc = new FakeDocument(camera);
  const win = new FakeWindow(doc);
  bootstrap(win);
  for (let i = 0; i < 10; i++) win.interval();
  assert.equal(win.consoleEntries.filter(([, code]) => code.includes('PROBE_STATE_CHANGED')).length, 1);
  doc.button.dispatchEvent(new Event('click'));
  camera.pivot_0.update_sl07mc$(0.02, { x: 5, y: 7, z: 10 });
  for (let i = 1; i <= 60; i++) win.frame(i * 16);
  assert.equal(win.consoleEntries.filter(([, code]) => code.includes('CAMERA_HOOKS_USED')).length, 1);
  doc.logButton.dispatchEvent(new Event('click'));
  assert.match(doc.logArea.value, /"pivotUpdates": 1/);
  win.dispatchEvent(new Event('pagehide'));
});
