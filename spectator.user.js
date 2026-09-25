// ==UserScript==
// @name         Tanki Online — Spectator (свободная камера)
// @namespace    https://github.com/Skillovaya/spectator
// @version      0.1.0
// @description  Локальная свободная камера в браузерной версии Танков Онлайн; не даёт права настоящего спектатора.
// @match        https://tankionline.com/play*
// @match        https://*.tankionline.com/play*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // These are private names of the HTML5 client's FollowCamera, not a public API.
  // If the client changes, fail closed rather than modifying a different object.
  const PIVOT_UPDATE = 'update_sl07mc$';
  const NUMBER_UPDATE = 'update_dleff0$';
  const MOVE_KEYS = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'
  ]);
  const MIN_SPEED = 100;
  const MAX_SPEED = 12000;
  const CAMERA_DISTANCE = 10; // Avoid a zero-length look-at vector.
  const MAX_PITCH = Math.PI / 2 - 0.06;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const isVec3 = value => value && Number.isFinite(value.x) &&
    Number.isFinite(value.y) && Number.isFinite(value.z);
  const cloneVec3 = value => ({ x: value.x, y: value.y, z: value.z });
  const copyVec3 = (target, source) => {
    target.x = source.x;
    target.y = source.y;
    target.z = source.z;
  };

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    if (typeof value.toArray === 'function') {
      try {
        const result = value.toArray();
        if (Array.isArray(result)) return result;
      } catch (_) { /* The game may be transitioning between battles. */ }
    }
    if (Array.isArray(value.array)) return value.array;
    if (Array.isArray(value.array_hd7ov6$_0)) return value.array_hd7ov6$_0;
    return [];
  }

  function findStore(doc) {
    const root = doc.getElementById('root');
    if (!root) return null;

    // React 17 and React 18 expose different root handles. Inspect only the
    // bounded Fiber tree, never window or the game's entire object graph.
    const reactKey = Object.keys(root).find(key => key.startsWith('__reactContainer$'));
    const fiber = root._reactRootContainer?._internalRoot?.current ||
      root._reactRootContainer?.current || (reactKey && root[reactKey]?.current) ||
      (reactKey && root[reactKey]);
    if (!fiber) return null;

    const queue = [fiber];
    const visited = new Set();
    for (let index = 0; index < queue.length && index < 500; index++) {
      const node = queue[index];
      if (!node || typeof node !== 'object' || visited.has(node)) continue;
      visited.add(node);
      try {
        const candidates = [
          node.memoizedState?.element?.type?.prototype?.store,
          node.type?.prototype?.store,
          node.stateNode?.store,
          node.memoizedProps?.store,
          node.memoizedState?.store
        ];
        const store = candidates.find(candidate => candidate?.subscribers && candidate?.state);
        if (store) return store;
        queue.push(node.child, node.sibling);
      } catch (_) { /* An unmounted Fiber is not a usable store. */ }
    }
    return null;
  }

  function findLocalTank(store) {
    if (!store) return null;
    const stats = store.state?.battleStatistics;
    if (stats?.battleLoaded === false) return null;
    if (typeof stats?.inBattle === 'function') {
      try {
        if (!stats.inBattle()) return null;
      } catch (_) { return null; }
    }

    const subscribers = asArray(store.subscribers);
    const local = subscribers.find(item => item?.tank?.tag === 'LocalTank');
    if (local) return local.tank;

    // Another HTML5 client layout keeps the possessed tank on the game mode.
    const world = subscribers.find(item => item?.tank?.world)?.tank.world;
    const gameEntity = asArray(world?.entities_0)[0];
    for (const component of asArray(gameEntity?.components_0)) {
      const tank = component?.gameMode_0?.possesedTank;
      if (tank?.components_0) return tank;
    }
    return null;
  }

  function findCameraInTank(tank) {
    let candidate = null;
    for (const component of asArray(tank?.components_0)) {
      if (!component || typeof component !== 'object') continue;
      if (isCompatibleCamera(component)) return component;
      if (component.pivot_0 && component.currState_0) candidate = component;
      for (const key of Object.keys(component)) {
        if (!/^followCamera/i.test(key) || !component[key]) continue;
        if (isCompatibleCamera(component[key])) return component[key];
        candidate ||= component[key];
      }
    }
    return candidate;
  }

  function isCompatibleCamera(camera) {
    return Boolean(camera &&
      isVec3(camera.pivot_0?.value) &&
      typeof camera.pivot_0[PIVOT_UPDATE] === 'function' &&
      typeof camera.polarDistance_0?.[NUMBER_UPDATE] === 'function' &&
      typeof camera.pitch_0?.[NUMBER_UPDATE] === 'function' &&
      typeof camera.elevation_0?.[NUMBER_UPDATE] === 'function' &&
      Number.isFinite(camera.polarDistance_0.value) &&
      Number.isFinite(camera.pitch_0.value) &&
      Number.isFinite(camera.elevation_0.value) &&
      Number.isFinite(camera.currState_0?.direction));
  }

  function resolveCamera(doc) {
    try {
      const store = findStore(doc);
      const tank = findLocalTank(store);
      if (!tank) return { camera: null, message: 'Откройте бой, чтобы включить камеру' };
      const camera = findCameraInTank(tank);
      if (!isCompatibleCamera(camera)) {
        return { camera: null, message: 'Камера клиента изменилась: эта версия не поддерживается' };
      }
      return { camera, message: '' };
    } catch (_) {
      // During battle transitions the game can unmount its store mid-read.
      return { camera: null, message: 'Ожидание загрузки камеры боя' };
    }
  }

  function createFlight(camera, speed = 1800) {
    const yaw = camera.currState_0.direction;
    const rawPitch = camera.pathPosition_dl3fsr$_0 ?? camera.pathPosition ?? camera.pitch_0.value;
    const pitch = clamp(Number.isFinite(rawPitch) ? rawPitch : 0, -MAX_PITCH, MAX_PITCH);
    const pivot = camera.pivot_0.value;
    const distance = clamp(Number(camera.polarDistance_0.value) || 0, 0, 2500);
    // Prefer the actual rendered camera position, when supplied by the client.
    const rendered = camera.currState_0.position;
    const position = isVec3(rendered) ? cloneVec3(rendered) : {
      x: pivot.x + Math.sin(yaw) * Math.cos(pitch) * distance,
      y: pivot.y - Math.cos(yaw) * Math.cos(pitch) * distance,
      z: pivot.z + Math.sin(pitch) * distance + 150
    };
    return { position, yaw, pitch, speed: clamp(speed, MIN_SPEED, MAX_SPEED) };
  }

  function stepFlight(flight, keys, delta) {
    const dt = clamp(delta, 0, 0.05); // No jump after a background tab resumes.
    const pressed = code => keys.has(code);
    const left = pressed('ArrowLeft') ? 1 : 0;
    const right = pressed('ArrowRight') ? 1 : 0;
    flight.yaw += (left - right) * 1.8 * dt;
    flight.pitch = clamp(flight.pitch + ((pressed('ArrowDown') ? 1 : 0) -
      (pressed('ArrowUp') ? 1 : 0)) * 1.5 * dt, -MAX_PITCH, MAX_PITCH);

    const forward = (pressed('KeyW') ? 1 : 0) - (pressed('KeyS') ? 1 : 0);
    const strafe = (pressed('KeyD') ? 1 : 0) - (pressed('KeyA') ? 1 : 0);
    const vertical = (pressed('KeyE') ? 1 : 0) - (pressed('KeyQ') ? 1 : 0);
    const cosYaw = Math.cos(flight.yaw);
    const sinYaw = Math.sin(flight.yaw);
    const cosPitch = Math.cos(flight.pitch);
    const dx = -sinYaw * cosPitch * forward + cosYaw * strafe;
    const dy = cosYaw * cosPitch * forward + sinYaw * strafe;
    const dz = -Math.sin(flight.pitch) * forward + vertical;
    const length = Math.hypot(dx, dy, dz) || 1;
    const fast = pressed('ShiftLeft') || pressed('ShiftRight') ? 4 : 1;
    const slow = pressed('ControlLeft') || pressed('ControlRight') ? 0.25 : 1;
    const amount = flight.speed * fast * slow * dt / Math.max(length, 1);
    flight.position.x += dx * amount;
    flight.position.y += dy * amount;
    flight.position.z += dz * amount;
  }

  function lookFlight(flight, dx, dy) {
    flight.yaw -= dx * 0.0025;
    flight.pitch = clamp(flight.pitch + dy * 0.0025, -MAX_PITCH, MAX_PITCH);
  }

  // Patch only this camera instance, and restore the original property
  // descriptors when freecam is turned off. Never alter tank physics or packets.
  function replaceMethod(object, key, makeWrapper) {
    const own = Object.getOwnPropertyDescriptor(object, key);
    const original = object[key];
    if (typeof original !== 'function') throw new Error(`Нет метода камеры: ${key}`);
    const wrapped = makeWrapper(original);
    if (own?.configurable) {
      Object.defineProperty(object, key, {
        configurable: true, enumerable: own.enumerable, writable: true, value: wrapped
      });
    } else {
      object[key] = wrapped;
    }
    if (object[key] !== wrapped) throw new Error(`Не удалось подключить камеру: ${key}`);
    return () => {
      if (object[key] !== wrapped) return; // Another script replaced it meanwhile.
      if (own) Object.defineProperty(object, key, own);
      else delete object[key];
    };
  }

  function forceDirection(state, flight) {
    const own = Object.getOwnPropertyDescriptor(state, 'direction');
    if (own && !own.configurable) throw new Error('Направление камеры недоступно');
    let prototype = Object.getPrototypeOf(state);
    let inherited;
    while (prototype && !inherited) {
      inherited = Object.getOwnPropertyDescriptor(prototype, 'direction');
      prototype = Object.getPrototypeOf(prototype);
    }
    let normalDirection = state.direction;
    let wasWritten = false;
    const getter = () => flight.yaw;
    const setter = value => {
      normalDirection = value;
      wasWritten = true;
      const originalSetter = own ? own.set : inherited?.set;
      if (typeof originalSetter === 'function') originalSetter.call(state, value);
    };
    Object.defineProperty(state, 'direction', {
      configurable: true, enumerable: own?.enumerable ?? true, get: getter, set: setter
    });
    return () => {
      if (Object.getOwnPropertyDescriptor(state, 'direction')?.get !== getter) return;
      if (own) {
        Object.defineProperty(state, 'direction', 'value' in own ?
          { ...own, value: normalDirection } : own);
      } else {
        delete state.direction;
        // A normal assignment to a writable inherited data property would
        // have created an own property. Preserve that value on detach.
        if (wasWritten && !inherited?.set) state.direction = normalDirection;
      }
    };
  }

  function attachFreeCamera(camera, flight) {
    if (!isCompatibleCamera(camera)) throw new Error('Несовместимая камера');
    const restores = [];
    const initialState = camera.currState_0;
    const initialPivot = cloneVec3(camera.pivot_0.value);
    const initialDistance = camera.polarDistance_0.value;
    const initialPitch = camera.pitch_0.value;
    const initialElevation = camera.elevation_0.value;
    const pathKey = typeof camera.pathPosition_dl3fsr$_0 === 'number' ?
      'pathPosition_dl3fsr$_0' : (typeof camera.pathPosition === 'number' ? 'pathPosition' : null);
    const initialPath = pathKey && camera[pathKey];
    const initialPathPoint = camera.pathPointElevation_0;
    let lastTankPosition = null;

    function restore() {
      let failure = null;
      // Always attempt every restoration, even if another extension has made
      // one of the camera properties read-only in the meantime.
      for (const undo of restores.splice(0).reverse()) {
        try { undo(); } catch (error) { failure ||= error; }
      }
      const reset = (object, key, value) => {
        try { object[key] = value; } catch (error) { failure ||= error; }
      };
      if (isVec3(camera.pivot_0.value)) {
        try { copyVec3(camera.pivot_0.value, lastTankPosition || initialPivot); }
        catch (error) { failure ||= error; }
      }
      reset(camera.polarDistance_0, 'value', initialDistance);
      reset(camera.pitch_0, 'value', initialPitch);
      reset(camera.elevation_0, 'value', initialElevation);
      if (pathKey) reset(camera, pathKey, initialPath);
      if (typeof initialPathPoint === 'number') reset(camera, 'pathPointElevation_0', initialPathPoint);
      if (pathKey && typeof camera.updatePathPoint_0 === 'function') {
        try { camera.updatePathPoint_0(); } catch (error) { failure ||= error; }
      }
      if (failure) throw failure;
    }

    try {
      restores.push(forceDirection(initialState, flight));
      if (camera.prevState_0 && camera.prevState_0 !== initialState &&
          Number.isFinite(camera.prevState_0.direction)) {
        restores.push(forceDirection(camera.prevState_0, flight));
      }
      restores.push(replaceMethod(camera.pivot_0, PIVOT_UPDATE, original => function (...args) {
        if (isVec3(args[1])) lastTankPosition = cloneVec3(args[1]);
        const result = original.apply(this, args);
        copyVec3(this.value, flight.position);
        return result;
      }));
      for (const [smoother, readValue] of [
        [camera.polarDistance_0, () => CAMERA_DISTANCE],
        [camera.pitch_0, () => flight.pitch],
        [camera.elevation_0, () => flight.pitch + 0.2]
      ]) {
        restores.push(replaceMethod(smoother, NUMBER_UPDATE, original => function (...args) {
          const result = original.apply(this, args);
          this.value = readValue();
          return result;
        }));
      }
      if (typeof camera.getCollisionTime_0 === 'function') {
        restores.push(replaceMethod(camera, 'getCollisionTime_0', () => () => 1));
      }

      function sync() {
        if (camera.currState_0 !== initialState || !isVec3(camera.pivot_0.value)) {
          throw new Error('Камера боя сменилась');
        }
        copyVec3(camera.pivot_0.value, flight.position);
        camera.polarDistance_0.value = CAMERA_DISTANCE;
        camera.pitch_0.value = flight.pitch;
        camera.elevation_0.value = flight.pitch + 0.2;
        if (pathKey && camera[pathKey] !== flight.pitch) {
          camera[pathKey] = flight.pitch;
          if (typeof camera.pathPointElevation_0 === 'number') {
            camera.pathPointElevation_0 = flight.pitch;
          }
          if (typeof camera.updatePathPoint_0 === 'function') camera.updatePathPoint_0();
        }
      }
      sync();
      return { sync, detach: restore };
    } catch (error) {
      try { restore(); } catch (restoreError) {
        console.warn('[Spectator] Ошибка при откате камеры:', restoreError);
      }
      throw error;
    }
  }

  function createPanel(doc, onToggle) {
    const host = doc.createElement('div');
    host.id = 'tanki-spectator-panel';
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      * { box-sizing: border-box; }
      .panel { width: 264px; padding: 12px 14px; color: #f4f6f9; background: rgba(16,22,31,.92);
        border: 1px solid #43546a; border-radius: 10px; box-shadow: 0 8px 24px #0008;
        font: 13px/1.4 system-ui, sans-serif; user-select: none; }
      strong { display: block; font-size: 15px; margin-bottom: 4px; }
      #status { display: block; min-height: 36px; color: #b8c9dc; }
      #status.active { color: #80e5ae; }
      #status.error { color: #ffb7a9; }
      button { display: block; width: 100%; margin: 8px 0; padding: 7px; border: 0; border-radius: 6px;
        background: #346dd0; color: white; font: inherit; font-weight: 600; cursor: pointer; }
      button:hover { background: #4682e8; }
      small { display: block; color: #a7b7c8; }
    </style><div class="panel" role="region" aria-label="Свободная камера">
      <strong>Спектатор · F8</strong><span id="status" role="status">Поиск боя…</span>
      <button id="toggle" type="button">Открепить камеру</button>
      <small>WASD — полёт · Q/E — вниз/вверх<br>Зажать ПКМ или стрелки — обзор<br>
        Shift/Ctrl — ускорить/замедлить<br>Колесо — скорость · F8/Esc — выход</small>
    </div>`;
    const status = shadow.querySelector('#status');
    const button = shadow.querySelector('#toggle');
    button.addEventListener('click', onToggle);
    for (const name of ['mousedown', 'mouseup', 'click', 'wheel', 'contextmenu']) {
      host.addEventListener(name, event => event.stopPropagation());
    }
    doc.documentElement.appendChild(host);
    return {
      host,
      update(message, active = false, error = false) {
        status.textContent = message;
        status.className = active ? 'active' : (error ? 'error' : '');
        button.textContent = active ? 'Вернуть камеру' : 'Открепить камеру';
      }
    };
  }

  function isEditing(target) {
    return Boolean(target?.isContentEditable ||
      target?.closest?.('input, textarea, select, [contenteditable="true"]'));
  }

  function bootstrap(win) {
    const singleton = Symbol.for('skillovaya.spectator.instance');
    if (win[singleton]) return;
    win[singleton] = true;
    const doc = win.document;
    const held = new Set();
    const gameHeld = new Set();
    let panel = null;
    let flight = null;
    let adapter = null;
    let activeCamera = null;
    let failedCamera = null;
    let frame = 0;
    let lastFrame = 0;
    let lastSpeed = 1800;
    let dragging = false;
    let ownedLock = false;
    let requestedElement = null;

    const inPanel = event => panel && event.composedPath?.().includes(panel.host);
    const display = (message, active = false, error = false) => panel?.update(message, active, error);

    function releaseLock() {
      if (ownedLock && doc.pointerLockElement === requestedElement) {
        try { doc.exitPointerLock?.(); } catch (_) { /* The page may have lost focus. */ }
      }
      ownedLock = false;
      requestedElement = null;
    }

    function stop(message = 'Камера снова прикреплена') {
      if (!flight) return;
      win.cancelAnimationFrame(frame);
      lastSpeed = flight.speed;
      flight = null;
      held.clear();
      dragging = false;
      releaseLock();
      try { adapter?.detach(); } catch (error) { console.warn('[Spectator] Не удалось вернуть камеру', error); }
      adapter = null;
      activeCamera = null;
      lastFrame = 0;
      display(message);
    }

    function tick(time) {
      if (!flight) return;
      try {
        if (!doc.hidden && !isEditing(doc.activeElement)) {
          stepFlight(flight, held, lastFrame ? (time - lastFrame) / 1000 : 0);
        }
        adapter.sync();
        lastFrame = time;
        frame = win.requestAnimationFrame(tick);
      } catch (error) {
        console.warn('[Spectator] Режим отключён:', error);
        stop('Камера сменилась; включите режим после входа в бой');
      }
    }

    function toggle() {
      if (flight) { stop(); return; }
      if (gameHeld.size) {
        display('Сначала отпустите клавиши управления танком', false, true);
        return;
      }
      const found = resolveCamera(doc);
      if (!found.camera) { display(found.message, false, true); return; }
      try {
        const nextFlight = createFlight(found.camera, lastSpeed);
        const nextAdapter = attachFreeCamera(found.camera, nextFlight);
        flight = nextFlight;
        adapter = nextAdapter;
        activeCamera = found.camera;
        failedCamera = null;
        held.clear();
        lastFrame = 0;
        display(`Камера откреплена · ${Math.round(flight.speed)} ед/с`, true);
        frame = win.requestAnimationFrame(tick);
      } catch (error) {
        failedCamera = found.camera;
        console.warn('[Spectator] Не удалось включить камеру:', error);
        display('Камера клиента несовместима с этой версией скрипта', false, true);
      }
    }

    function keydown(event) {
      if (event.code === 'F8' && !event.repeat && !event.altKey && !event.metaKey &&
          !isEditing(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggle();
        return;
      }
      if (!flight) {
        if (MOVE_KEYS.has(event.code)) gameHeld.add(event.code);
        return;
      }
      if (event.code === 'Escape' && !isEditing(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        stop();
        return;
      }
      if (isEditing(event.target)) { held.clear(); return; }
      if (MOVE_KEYS.has(event.code)) {
        held.add(event.code);
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    function keyup(event) {
      gameHeld.delete(event.code);
      held.delete(event.code);
      if (flight && MOVE_KEYS.has(event.code) && !isEditing(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    function mouseDown(event) {
      if (!flight || inPanel(event)) return;
      if (event.button === 2) {
        dragging = true;
        if (!doc.pointerLockElement) {
          const canvas = doc.querySelector('canvas');
          if (canvas?.requestPointerLock) {
            requestedElement = canvas;
            try {
              Promise.resolve(canvas.requestPointerLock()).catch(() => {
                if (requestedElement === canvas) requestedElement = null;
              });
            } catch (_) { requestedElement = null; }
          }
        }
      }
      // Do not shoot or rotate the turret while operating the free camera.
      if (event.button === 2 || (event.button === 0 && event.target?.tagName === 'CANVAS')) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    function mouseUp(event) {
      if (!flight || inPanel(event) || event.button !== 2) return;
      dragging = false;
      releaseLock();
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    function pointerLockChange() {
      if (requestedElement && doc.pointerLockElement === requestedElement) ownedLock = true;
      else if (!doc.pointerLockElement) {
        releaseLock();
        dragging = false;
      } else if (requestedElement) {
        // The game locked a different element; leave its lock alone.
        ownedLock = false;
        requestedElement = null;
      }
    }

    function mouseMove(event) {
      if (!flight || inPanel(event)) return;
      if (dragging) lookFlight(flight, event.movementX || 0, event.movementY || 0);
      // Ignore game mouse-look even when the right button isn't held.
      event.stopImmediatePropagation();
    }

    function pointerEvent(event) {
      if (!flight || inPanel(event)) return;
      if (event.type === 'pointermove' || event.button === 2 ||
          (event.button === 0 && event.target?.tagName === 'CANVAS')) {
        // The client may listen for PointerEvents instead of MouseEvents.
        // Do not preventDefault on pointerdown: right-drag still needs mousedown.
        event.stopImmediatePropagation();
      }
    }

    function wheel(event) {
      if (!flight || inPanel(event) || isEditing(event.target)) return;
      flight.speed = clamp(flight.speed * Math.exp(-event.deltaY * 0.001), MIN_SPEED, MAX_SPEED);
      display(`Камера откреплена · ${Math.round(flight.speed)} ед/с`, true);
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    win.addEventListener('keydown', keydown, true);
    win.addEventListener('keyup', keyup, true);
    win.addEventListener('mousedown', mouseDown, true);
    win.addEventListener('mouseup', mouseUp, true);
    win.addEventListener('mousemove', mouseMove, true);
    win.addEventListener('pointerdown', pointerEvent, true);
    win.addEventListener('pointerup', pointerEvent, true);
    win.addEventListener('pointermove', pointerEvent, true);
    win.addEventListener('wheel', wheel, { capture: true, passive: false });
    win.addEventListener('contextmenu', event => {
      if (flight && !inPanel(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    win.addEventListener('blur', () => {
      held.clear();
      gameHeld.clear();
      dragging = false;
      releaseLock();
    });
    doc.addEventListener('pointerlockchange', pointerLockChange);
    win.addEventListener('pagehide', () => { stop(); win.clearInterval(checkTimer); });

    function mount() {
      if (panel || !doc.documentElement) return;
      panel = createPanel(doc, toggle);
      display(flight ? `Камера откреплена · ${Math.round(flight.speed)} ед/с` :
        'Откройте бой, чтобы включить камеру', Boolean(flight));
    }
    mount();
    if (!panel) doc.addEventListener('DOMContentLoaded', mount, { once: true });
    const checkTimer = win.setInterval(() => {
      if (!panel) mount();
      const found = resolveCamera(doc);
      if (flight && found.camera !== activeCamera) {
        stop('Бой или камера сменились; нажмите F8 после загрузки боя');
      } else if (!flight) {
        const failed = found.camera && found.camera === failedCamera;
        display(failed ? 'Камера клиента несовместима с этой версией скрипта' :
          (found.camera ? 'Готово: нажмите F8 или кнопку' : found.message), false, failed);
      }
    }, 1000);
  }

  // Export only the core for dependency-free Node tests; the installed
  // userscript starts directly in the game's page context (@grant none).
  if (typeof window === 'undefined' && typeof module !== 'undefined') {
    module.exports = {
      asArray, findStore, findLocalTank, findCameraInTank, isCompatibleCamera,
      resolveCamera, createFlight, stepFlight, lookFlight, attachFreeCamera, bootstrap
    };
  } else {
    bootstrap(window);
  }
})();
