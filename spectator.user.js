// ==UserScript==
// @name         Tanki Online — Spectator (свободная камера)
// @namespace    https://github.com/Skillovaya/spectator
// @version      0.4.0
// @description  Локальная свободная камера в браузерной версии Танков Онлайн; не даёт права настоящего спектатора.
// @match        https://tankionline.com/play*
// @match        https://*.tankionline.com/play*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @inject-into  page
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // These are private names of the HTML5 client's FollowCamera, not a public API.
  // If the client changes, fail closed rather than modifying a different object.
  const VERSION = '0.4.0';
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

  // Diagnostics contain only field names, types and booleans, not game values.
  // Bound and scrub even our own messages before putting them in the log.
  const PRIVATE_FIELD = /token|password|secret|cookie|session|auth|e-?mail|nickname|user(name)?/i;
  function scrubString(value) {
    return String(value)
      .replace(/https?:\/\/[^\s)]+/gi, '<url>')
      .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '<email>')
      .replace(/\b(token|password|secret|cookie|session|auth)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
      .slice(0, 240);
  }

  function safeKeys(value, limit = 16) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return [];
    try {
      return Object.keys(value).slice(0, limit).map(key =>
        PRIVATE_FIELD.test(key) ? '<hidden field>' : scrubString(key).slice(0, 48));
    } catch (_) { return ['<keys inaccessible>']; }
  }

  function collectionShape(value) {
    return {
      type: Array.isArray(value) ? 'array' : typeof value,
      count: asArray(value).length,
      keys: safeKeys(value, 8),
      toArray: typeof value?.toArray === 'function'
    };
  }

  function safeError(error) {
    return {
      name: scrubString(error?.name || 'Error'),
      message: scrubString(error?.message || 'unknown'),
      stack: scrubString(String(error?.stack || '').split('\n').slice(0, 3).join(' | '))
    };
  }

  function createDiagnostics(win) {
    const events = [];
    // Prevent accidental logging of a raw game/store object in a future call.
    const allowedFields = new Set([
      'version', 'result', 'trace', 'active', 'activity', 'error', 'reason',
      'from', 'to', 'code', 'heldKeys', 'stage', 'hasPathControl',
      'currentProbe', 'pointerLocked', 'pivotUpdates', 'numberUpdates', 'syncs'
    ]);
    let totalSize = 0;
    function sanitize(value, depth = 0) {
      if (typeof value === 'string') return scrubString(value);
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      if (value == null) return null;
      if (depth >= 8) return '<depth limit>';
      if (Array.isArray(value)) return value.slice(0, 32).map(item => sanitize(item, depth + 1));
      if (Object.getPrototypeOf(value) !== Object.prototype) return '<non-plain object>';
      return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [
        PRIVATE_FIELD.test(key) ? '<hidden field>' : scrubString(key),
        PRIVATE_FIELD.test(key) ? '<redacted>' : sanitize(item, depth + 1)
      ]));
    }
    return {
      record(level, code, details = {}) {
        let snapshot;
        try {
          snapshot = sanitize(Object.fromEntries(Object.entries(details).filter(([key]) =>
            allowedFields.has(key))));
        } catch (_) { snapshot = { error: 'diagnostic data unreadable' }; }
        const entry = {
          time: new Date().toISOString(),
          level,
          code,
          details: snapshot
        };
        const size = JSON.stringify(entry).length;
        events.push(entry);
        totalSize += size;
        while (events.length > 50 || totalSize > 80000 && events.length > 1) {
          totalSize -= JSON.stringify(events.shift()).length;
        }
        try {
          const output = win.console?.[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'];
          output?.call(win.console, `[Spectator ${VERSION}] ${code}`, entry.details);
        } catch (_) { /* Logging must never interrupt camera restoration. */ }
      },
      report() {
        return JSON.stringify({
          script: 'Spectator',
          version: VERSION,
          host: scrubString(win.location?.hostname || 'unknown'), // No URL or query string.
          events
        }, null, 2);
      }
    };
  }

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

  function findStore(doc, trace, fibers) {
    const root = doc.getElementById('root');
    const canvas = doc.querySelector?.('canvas');
    if (trace) trace.root = {
      found: Boolean(root),
      canvasFound: Boolean(canvas),
      childCount: root?.children?.length ?? null
    };

    // The game may mount React under #root, in a sibling, or around the WebGL
    // canvas. Inspect a bounded set of DOM nodes; never crawl window/globals.
    const elements = [];
    const seenElements = new Set();
    const addElement = (element, source) => {
      if (!element || typeof element !== 'object' || seenElements.has(element) || elements.length >= 128) return;
      seenElements.add(element);
      elements.push({ element, source });
    };
    addElement(root, 'root');
    addElement(canvas, 'canvas');
    for (let element = canvas?.parentElement, depth = 0; element && depth < 10;
      element = element.parentElement, depth++) addElement(element, 'canvas.ancestor');
    for (let element = root?.parentElement, depth = 0; element && depth < 4;
      element = element.parentElement, depth++) addElement(element, 'root.ancestor');
    addElement(doc.body, 'body');
    addElement(doc.documentElement, 'document');

    const domQueue = [root, doc.body];
    const scanned = new Set();
    for (let index = 0; index < domQueue.length && elements.length < 128 && index < 128; index++) {
      const element = domQueue[index];
      if (!element || scanned.has(element)) continue;
      scanned.add(element);
      const children = element.children;
      for (let child = 0; children && child < Math.min(children.length, 16); child++) {
        addElement(children[child], 'descendant');
        domQueue.push(children[child]);
      }
    }

    const seeds = [];
    const markers = { react17: 0, react18: 0, fiber: 0 };
    const addSeed = (fiber, kind, source) => {
      markers[kind]++;
      if (fiber && typeof fiber === 'object' && seeds.length < 128) {
        seeds.push({ fiber, kind, source });
      }
    };
    let domReadErrors = 0;
    let domKeysTruncated = 0;
    for (const { element, source } of elements) {
      try {
        const legacy = element._reactRootContainer;
        if (legacy) addSeed(legacy._internalRoot?.current || legacy.current, 'react17', source);
        const keys = Object.keys(element);
        if (keys.length > 256) domKeysTruncated++;
        for (const key of keys.slice(0, 256)) {
          if (key.startsWith('__reactContainer$')) {
            addSeed(element[key]?.current || element[key], 'react18', source);
          } else if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
            addSeed(element[key], 'fiber', source);
          }
        }
      } catch (_) { domReadErrors++; }
    }
    if (trace) trace.react = {
      handle: seeds[0]?.kind || 'none',
      source: seeds[0]?.source || null,
      fiberFound: seeds.length > 0,
      nodesChecked: 0,
      domNodesChecked: elements.length,
      domReadErrors,
      domKeysTruncated,
      markers,
      storePath: null
    };
    if (!seeds.length) return null;

    const isGameStore = value => Boolean(value && typeof value === 'object' &&
      value.subscribers && value.state);
    const queue = seeds.slice();
    const visited = new Set();
    let firstStore = null;
    for (let index = 0; index < queue.length && visited.size < 700; index++) {
      const { fiber: node, kind, source } = queue[index];
      if (!node || typeof node !== 'object' || visited.has(node)) continue;
      visited.add(node);
      if (fibers) fibers.push(node); // Transient references: never put Fibers in the log.
      if (trace) trace.react.nodesChecked = visited.size;
      const found = (store, path) => {
        if (!isGameStore(store)) return null;
        if (!firstStore) {
          firstStore = store;
          if (trace) Object.assign(trace.react, { handle: kind, source, storePath: path });
        }
        return store;
      };
      try {
        const candidates = [
          ['memoizedState.element.type.prototype.store', node.memoizedState?.element?.type?.prototype?.store],
          ['type.prototype.store', node.type?.prototype?.store],
          ['stateNode.store', node.stateNode?.store],
          ['memoizedProps.store', node.memoizedProps?.store],
          ['memoizedProps.value', node.memoizedProps?.value],
          ['memoizedState.store', node.memoizedState?.store],
          ['memoizedState.element.props.store', node.memoizedState?.element?.props?.store],
          ['stateNode.context.store', node.stateNode?.context?.store]
        ];
        for (const [path, value] of candidates) {
          const store = found(value, path);
          if (store && !fibers) return store;
        }
        // Function components may hold the store in the first few React hooks.
        const checkedHooks = new Set();
        for (let hook = node.memoizedState, count = 0; hook && typeof hook === 'object' &&
          count < 8 && !checkedHooks.has(hook); hook = hook.next, count++) {
          checkedHooks.add(hook);
          const store = found(hook.memoizedState, `hook[${count}].memoizedState`) ||
            found(hook.memoizedState?.store, `hook[${count}].memoizedState.store`);
          if (store && !fibers) return store;
        }
        for (const fiber of [node.return, node.child, node.sibling, node.alternate]) {
          if (fiber && !visited.has(fiber)) queue.push({ fiber, kind, source });
        }
      } catch (error) {
        if (trace) {
          trace.react.nodeReadErrors = (trace.react.nodeReadErrors || 0) + 1;
          trace.react.firstNodeError ||= safeError(error);
        }
      }
    }
    if (trace) trace.react.searchLimitReached = visited.size >= 700;
    return firstStore;
  }

  function findLocalTank(store, trace) {
    if (!store) return null;
    const stats = store.state?.battleStatistics;
    if (trace) trace.store = {
      hasBattleStats: Boolean(stats),
      battleLoaded: typeof stats?.battleLoaded === 'boolean' ? stats.battleLoaded : null,
      inBattle: null,
      subscribers: collectionShape(store.subscribers)
    };
    if (stats?.battleLoaded === false) return null;
    if (typeof stats?.inBattle === 'function') {
      try {
        const inBattle = Boolean(stats.inBattle());
        if (trace) trace.store.inBattle = inBattle;
        if (!inBattle) return null;
      } catch (error) {
        if (trace) trace.store.inBattleError = safeError(error);
        return null;
      }
    }

    const subscribers = asArray(store.subscribers);
    if (trace) trace.store.subscriberSample = subscribers.slice(0, 8).map(item => ({
      fields: safeKeys(item, 10),
      hasTank: Boolean(item?.tank),
      isLocalTank: item?.tank?.tag === 'LocalTank',
      hasWorld: Boolean(item?.tank?.world)
    }));
    const local = subscribers.find(item => item?.tank?.tag === 'LocalTank');
    if (local) {
      if (trace) trace.tank = { source: 'subscriber', components: collectionShape(local.tank.components_0) };
      return local.tank;
    }

    // Another HTML5 client layout keeps the possessed tank on the game mode.
    const world = subscribers.find(item => item?.tank?.world)?.tank.world;
    const gameEntity = asArray(world?.entities_0)[0];
    if (trace) trace.world = {
      found: Boolean(world),
      entities: collectionShape(world?.entities_0),
      gameComponents: collectionShape(gameEntity?.components_0)
    };
    for (const component of asArray(gameEntity?.components_0)) {
      const tank = component?.gameMode_0?.possesedTank;
      if (tank?.components_0) {
        if (trace) trace.tank = { source: 'gameMode.possesedTank', components: collectionShape(tank.components_0) };
        return tank;
      }
    }
    return null;
  }

  function cameraProblems(camera) {
    if (!camera) return ['объект камеры отсутствует'];
    const missing = [];
    if (!isVec3(camera.pivot_0?.value)) missing.push('pivot_0.value(x,y,z)');
    if (typeof camera.pivot_0?.[PIVOT_UPDATE] !== 'function') missing.push(`pivot_0.${PIVOT_UPDATE}`);
    for (const name of ['polarDistance_0', 'pitch_0', 'elevation_0']) {
      if (typeof camera[name]?.[NUMBER_UPDATE] !== 'function') missing.push(`${name}.${NUMBER_UPDATE}`);
      if (!Number.isFinite(camera[name]?.value)) missing.push(`${name}.value`);
    }
    if (!Number.isFinite(camera.currState_0?.direction)) missing.push('currState_0.direction');
    return missing;
  }

  function isCompatibleCamera(camera) {
    return cameraProblems(camera).length === 0;
  }

  function findCameraInTank(tank, trace) {
    const components = asArray(tank?.components_0);
    if (trace) trace.cameraSearch = { componentCount: components.length, componentFields: [], candidates: [] };
    let candidate = null;
    let fewestProblems = Infinity;
    function consider(value, source) {
      const missing = cameraProblems(value);
      if (trace && trace.cameraSearch.candidates.length < 12) {
        trace.cameraSearch.candidates.push({
          source,
          fields: safeKeys(value, 18),
          pivotFields: safeKeys(value?.pivot_0, 10),
          stateFields: safeKeys(value?.currState_0, 10),
          missing
        });
      }
      if (!missing.length) {
        if (trace) trace.cameraSearch.selected = source;
        candidate = value;
        return true;
      }
      if (missing.length < fewestProblems) {
        candidate = value;
        fewestProblems = missing.length;
        if (trace) trace.cameraSearch.closest = source;
      }
      return false;
    }

    for (let index = 0; index < components.length; index++) {
      const component = components[index];
      if (!component || typeof component !== 'object') continue;
      const fields = Object.keys(component);
      if (trace && trace.cameraSearch.componentFields.length < 24) {
        trace.cameraSearch.componentFields.push({ index, fields: safeKeys(component, 14) });
      }
      if ((component.pivot_0 || component.currState_0) && consider(component, `components[${index}]`)) {
        return component;
      }
      for (const key of fields) {
        if (!/^followCamera/i.test(key) || !component[key]) continue;
        if (consider(component[key], `components[${index}].${scrubString(key)}`)) return component[key];
      }
    }
    return candidate;
  }

  // A store is only one possible route to the FollowCamera. Current builds may
  // expose game instances in React props, hooks, refs or context instead. Follow
  // references from Fibers, never window/globals; inspect descriptors rather
  // than invoking unknown getters and stop at strict depth/object limits.
  function findCameraFromFibers(fibers, trace) {
    const MAX_OBJECTS = 1200;
    const MAX_REFERENCES = 2400;
    const MAX_DEPTH = 5;
    const GAME_FIELD = /camera|tank|battle|game|world|scene|engine|render|component|entity|posses|physics|controller|store/i;
    const ROUTE_FIELD = /camera|tank|battle|game|world|scene|engine|render|component|entity|posses|physics|controller|store|context|state|value|current|ref|array|props|body|data|manager|instance|model|children/i;
    const pathField = key => !PRIVATE_FIELD.test(key) &&
      /^[a-z_$][\w$]{0,48}$/i.test(key) && ROUTE_FIELD.test(key) ? key : '<field>';
    const high = [];
    const low = [];
    const seen = new Set();
    let readErrors = 0;
    let inspected = 0;
    let fieldsTruncated = 0;
    const hints = [];
    const tanks = new Map();
    const cameras = new Map();
    const enqueue = (value, path, depth, priority = false) => {
      if (!value || typeof value !== 'object' || seen.has(value) ||
        seen.size >= MAX_REFERENCES || depth > MAX_DEPTH) return;
      try {
        if (typeof value.nodeType === 'number' || ArrayBuffer.isView(value) ||
          value instanceof ArrayBuffer) return;
      } catch (_) { readErrors++; return; }
      seen.add(value);
      (priority ? high : low).push({ value, path, depth });
    };
    const anchors = { instance: 0, context: 0, ref: 0, prototype: 0, hook: 0, state: 0, props: 0 };
    const addAnchor = (value, kind, priority) => {
      const before = seen.size;
      enqueue(value, `fiber.${kind}`, 0, priority);
      if (seen.size > before) anchors[kind]++;
    };
    for (const fiber of fibers) {
      try {
        addAnchor(fiber.stateNode, 'instance', true);
        addAnchor(fiber.dependencies?.firstContext?.memoizedValue, 'context', true);
        addAnchor(fiber.ref?.current, 'ref', true);
        addAnchor(fiber.type?.prototype, 'prototype', true);
        const hooks = new Set();
        for (let hook = fiber.memoizedState, count = 0; hook && typeof hook === 'object' &&
          count < 8 && !hooks.has(hook); hook = hook.next, count++) {
          hooks.add(hook);
          addAnchor(hook.memoizedState, 'hook', true);
        }
        addAnchor(fiber.memoizedState, 'state', false);
        addAnchor(fiber.memoizedProps, 'props', false);
      } catch (_) { readErrors++; }
    }
    const readOwn = (value, key) => {
      if (!value || typeof value !== 'object') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    };
    const addTank = (tank, path) => {
      if (tank && typeof tank === 'object' && readOwn(tank, 'components_0') && !tanks.has(tank)) {
        tanks.set(tank, path);
      }
    };
    let highIndex = 0;
    let lowIndex = 0;
    let highVisited = 0;
    while (inspected < MAX_OBJECTS && (highIndex < high.length || lowIndex < low.length)) {
      const useHigh = highIndex < high.length && (highVisited < 850 || lowIndex >= low.length);
      const { value, path, depth } = useHigh ? high[highIndex++] : low[lowIndex++];
      if (useHigh) highVisited++;
      inspected++;
      try {
        const ownKeys = Array.isArray(value) ? [] : Object.keys(value);
        if (ownKeys.length > 96) fieldsTruncated++;
        const keys = ownKeys.slice(0, 96);
        if (keys.some(key => GAME_FIELD.test(key)) && hints.length < 8) {
          const fields = keys.filter(key => GAME_FIELD.test(key) && !PRIVATE_FIELD.test(key))
            .slice(0, 6).map(pathField);
          if (fields.length) hints.push({ path, fields });
        }
        if (readOwn(value, 'tag') === 'LocalTank') addTank(value, path);
        addTank(readOwn(value, 'possesedTank'), `${path}.possesedTank`);
        addTank(readOwn(readOwn(value, 'gameMode_0'), 'possesedTank'),
          `${path}.gameMode_0.possesedTank`);
        if (readOwn(value, 'isPossessed') === true) addTank(readOwn(value, 'data'), `${path}.data`);
        if (readOwn(value, 'state') && readOwn(value, 'subscribers')) {
          addTank(findLocalTank(value), `${path}.store`);
        }
        if (readOwn(value, 'pivot_0') && readOwn(value, 'currState_0')) {
          const missing = cameraProblems(value);
          cameras.set(value, { path, missing });
        }
        if (depth >= MAX_DEPTH) continue;
        if (Array.isArray(value)) {
          for (const item of value.slice(0, 16)) enqueue(item, `${path}[]`, depth + 1);
          continue;
        }
        // Read own data properties only; getters and methods on game objects
        // must not be run by a diagnostic search.
        const safeKeysToFollow = keys.filter(key =>
          !PRIVATE_FIELD.test(key) && !key.startsWith('__react') && key !== '__proto__');
        const likely = safeKeysToFollow.filter(key => ROUTE_FIELD.test(key)).slice(0, 24);
        const other = safeKeysToFollow.filter(key => !ROUTE_FIELD.test(key)).slice(0, 8);
        for (const key of [...likely, ...other]) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !('value' in descriptor)) continue;
          enqueue(descriptor.value, `${path}.${pathField(key)}`, depth + 1, ROUTE_FIELD.test(key));
        }
      } catch (_) { readErrors++; }
    }
    const compatible = [...cameras].filter(([, shape]) => shape.missing.length === 0);
    const fromTanks = [...tanks].map(([tank, path]) => ({
      camera: findCameraInTank(tank, tanks.size === 1 ? trace : null), path
    })).filter(item => item.camera);
    const localCompatible = fromTanks.filter(item => isCompatibleCamera(item.camera));
    if (trace) trace.discovery = {
      fibers: fibers.length,
      anchors,
      references: seen.size,
      objectsChecked: inspected,
      limitReached: inspected >= MAX_OBJECTS || seen.size >= MAX_REFERENCES,
      fieldsTruncated,
      readErrors,
      localTanks: tanks.size,
      cameraLike: cameras.size,
      compatibleCameras: compatible.length,
      hints,
      candidates: [...cameras.values()].slice(0, 6).map(({ path, missing }) => ({ path, missing })),
      selected: null,
      path: null
    };
    const selected = (camera, source, path) => {
      if (trace) Object.assign(trace.discovery, { selected: source, path });
      return { camera, code: 'READY' };
    };
    if (localCompatible.length === 1) {
      return selected(localCompatible[0].camera, 'localTank', localCompatible[0].path);
    }
    if (localCompatible.length > 1 || (tanks.size === 0 && compatible.length > 1)) {
      return { camera: null, code: 'CAMERA_AMBIGUOUS' };
    }
    if (tanks.size) {
      if (fromTanks.length) return { camera: fromTanks[0].camera, code: 'CAMERA_INCOMPATIBLE' };
      return { camera: null, code: 'CAMERA_NOT_FOUND' };
    }
    // A unique camera with the full FollowCamera signature is safe to try as a
    // local, reversible patch. Never guess if several plausible cameras exist.
    if (compatible.length === 1) {
      return selected(compatible[0][0], 'uniqueFollowCamera', compatible[0][1].path);
    }
    if (cameras.size === 1) return { camera: [...cameras.keys()][0], code: 'CAMERA_INCOMPATIBLE' };
    return { camera: null, code: 'CAMERA_PATH_NOT_FOUND' };
  }

  function resolveCamera(doc, trace) {
    const details = trace || {};
    const result = (camera, code, message = '') => {
      details.result = code;
      return { camera, code, message: camera ? '' : `[${code}] ${message}` };
    };
    try {
      const fibers = [];
      const store = findStore(doc, details, fibers);
      let legacyFailure = null;
      if (store) {
        const tank = findLocalTank(store, details);
        if (!tank) {
          if (details.store?.inBattleError) return result(null, 'BATTLE_STATE_ERROR', 'Не удалось прочитать состояние боя');
          if (details.store?.battleLoaded === false || details.store?.inBattle === false) {
            return result(null, 'BATTLE_NOT_READY', 'Дождитесь загрузки боя');
          }
          legacyFailure = ['LOCAL_TANK_NOT_FOUND', 'Не найден локальный танк'];
        } else {
          const camera = findCameraInTank(tank, details);
          if (camera && isCompatibleCamera(camera)) return result(camera, 'READY');
          legacyFailure = camera ?
            ['CAMERA_INCOMPATIBLE', `Не хватает поля ${cameraProblems(camera)[0]}`] :
            ['CAMERA_NOT_FOUND', 'Камера не найдена в компонентах танка'];
        }
      }

      // Do not require a Redux/Kotlin store: try the actual camera in the
      // bounded React object graph before reporting why discovery failed.
      const discovered = findCameraFromFibers(fibers, details);
      if (discovered.camera) {
        if (!store && !details.root?.canvasFound) {
          return result(null, 'BATTLE_NOT_READY', 'Дождитесь загрузки canvas боя');
        }
        const missing = cameraProblems(discovered.camera);
        if (!missing.length) return result(discovered.camera, 'READY');
        return result(null, 'CAMERA_INCOMPATIBLE', `Не хватает поля ${missing[0]}`);
      }
      if (!details.root?.found && !details.root?.canvasFound && !details.react?.fiberFound) {
        return result(null, 'ROOT_MISSING', 'Не загружены #root и canvas игры');
      }
      if (!details.react?.fiberFound) {
        const hasMarker = Object.values(details.react?.markers || {}).some(count => count > 0);
        return result(null, 'REACT_ROOT_MISSING', hasMarker ?
          'Маркеры React видны, но Fiber недоступен' :
          'На проверенных DOM-узлах не видна привязка React');
      }
      if (discovered.code === 'CAMERA_AMBIGUOUS') {
        return result(null, 'CAMERA_AMBIGUOUS', 'Несколько подходящих камер — выбор небезопасен');
      }
      if (legacyFailure && discovered.code === 'CAMERA_PATH_NOT_FOUND') {
        return result(null, ...legacyFailure);
      }
      if (discovered.code === 'CAMERA_NOT_FOUND') {
        return result(null, 'CAMERA_NOT_FOUND', 'Камера не найдена в компонентах локального танка');
      }
      return result(null, 'CAMERA_PATH_NOT_FOUND',
        'Камера не достижима из проверенных React-компонентов — откройте диагностику');
    } catch (error) {
      details.error = safeError(error);
      return result(null, 'PROBE_EXCEPTION', 'Ошибка поиска камеры — откройте диагностику');
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

  function attachFreeCamera(camera, flight, onRollbackFailure) {
    if (!isCompatibleCamera(camera)) throw new Error('Несовместимая камера');
    const restores = [];
    const activity = { pivotUpdates: 0, numberUpdates: 0, syncs: 0 };
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
        activity.pivotUpdates++;
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
          activity.numberUpdates++;
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
        activity.syncs++;
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
      return { sync, detach: restore, activity: () => ({ ...activity }) };
    } catch (error) {
      try { restore(); } catch (restoreError) {
        onRollbackFailure?.(safeError(restoreError));
      }
      throw error;
    }
  }

  function createPanel(doc, onToggle, onInspect, onCopy) {
    const host = doc.createElement('div');
    host.id = 'tanki-spectator-panel';
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .panel { width: 280px; max-width: calc(100vw - 32px); padding: 12px 14px; color: #f4f6f9;
        background: rgba(16,22,31,.94); border: 1px solid #43546a; border-radius: 10px;
        box-shadow: 0 8px 24px #0008; font: 13px/1.4 system-ui, sans-serif; user-select: none; }
      .panel.expanded { width: 420px; }
      strong { display: block; font-size: 15px; margin-bottom: 4px; }
      #status { display: block; min-height: 36px; color: #b8c9dc; overflow-wrap: anywhere; }
      #status.active { color: #80e5ae; }
      #status.error { color: #ffb7a9; }
      button { display: block; width: 100%; margin: 8px 0; padding: 7px; border: 0; border-radius: 6px;
        background: #346dd0; color: white; font: inherit; font-weight: 600; cursor: pointer; }
      button:hover { background: #4682e8; }
      button.secondary { background: #344558; }
      button.secondary:hover { background: #49627e; }
      small { display: block; color: #a7b7c8; }
      textarea { display: block; width: 100%; height: 170px; margin-top: 8px; padding: 8px;
        resize: vertical; background: #091019; border: 1px solid #43546a; border-radius: 5px;
        color: #d8edff; font: 11px/1.4 ui-monospace, monospace; user-select: text; }
    </style><div class="panel" role="region" aria-label="Свободная камера">
      <strong>Спектатор · F8</strong><span id="status" role="status">Поиск боя…</span>
      <button id="toggle" type="button">Открепить камеру</button>
      <button id="show-logs" class="secondary" type="button" aria-expanded="false">Показать диагностику</button>
      <div id="diagnostics" hidden>
        <small>Структура клиента и ошибки. Проверьте текст перед отправкой.</small>
        <textarea id="log" readonly spellcheck="false" aria-label="Диагностический лог"></textarea>
        <button id="copy" type="button">Скопировать лог</button>
        <small id="copy-status" role="status"></small>
      </div>
      <small>WASD — полёт · Q/E — вниз/вверх<br>Зажать ПКМ или стрелки — обзор<br>
        Shift/Ctrl — ускорить/замедлить<br>Колесо — скорость · F8/Esc — выход</small>
    </div>`;
    const container = shadow.querySelector('.panel');
    const status = shadow.querySelector('#status');
    const button = shadow.querySelector('#toggle');
    const logButton = shadow.querySelector('#show-logs');
    const details = shadow.querySelector('#diagnostics');
    const logArea = shadow.querySelector('#log');
    const copyStatus = shadow.querySelector('#copy-status');
    button.addEventListener('click', onToggle);
    logButton.addEventListener('click', () => {
      details.hidden = !details.hidden;
      container.classList.toggle('expanded', !details.hidden);
      logButton.setAttribute('aria-expanded', String(!details.hidden));
      logButton.textContent = details.hidden ? 'Показать диагностику' : 'Скрыть диагностику';
      if (!details.hidden) logArea.value = onInspect();
    });
    shadow.querySelector('#copy').addEventListener('click', onCopy);
    for (const name of ['mousedown', 'mouseup', 'click', 'wheel', 'contextmenu',
      'pointerdown', 'pointerup', 'pointermove']) {
      host.addEventListener(name, event => event.stopPropagation());
    }
    doc.documentElement.appendChild(host);
    return {
      host,
      update(message, active = false, error = false) {
        status.textContent = message;
        status.className = active ? 'active' : (error ? 'error' : '');
        button.textContent = active ? 'Вернуть камеру' : 'Открепить камеру';
      },
      setLog(text) { logArea.value = text; },
      copyMessage(text) { copyStatus.textContent = text; },
      selectLog() { logArea.focus(); logArea.select(); }
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
    const diagnostics = createDiagnostics(win);
    diagnostics.record('info', 'SCRIPT_LOADED', { version: VERSION });
    const held = new Set();
    const gameHeld = new Set();
    let panel = null;
    let flight = null;
    let adapter = null;
    let activeCamera = null;
    let failure = null;
    let lastProbeCode = null;
    let frame = 0;
    let lastFrame = 0;
    let lastSpeed = 1800;
    let framesSinceStart = 0;
    let activityReported = false;
    let firstMovementLogged = false;
    let firstMouseLookLogged = false;
    let dragging = false;
    let ownedLock = false;
    let requestedElement = null;

    const inPanel = event => panel && event.composedPath?.().includes(panel.host);
    const display = (message, active = false, error = false) => panel?.update(message, active, error);

    function inspect() {
      const trace = {};
      const found = resolveCamera(doc, trace);
      diagnostics.record(found.camera ? 'info' : 'warn', 'DIAGNOSTIC_SNAPSHOT', {
        result: found.code,
        active: Boolean(flight),
        activity: adapter?.activity?.() || null,
        trace
      });
      const report = diagnostics.report();
      panel?.setLog(report);
      return report;
    }

    async function copyReport() {
      const report = inspect();
      try {
        if (!win.navigator?.clipboard?.writeText) throw new Error('Clipboard API unavailable');
        await win.navigator.clipboard.writeText(report);
        panel?.copyMessage('Лог скопирован. Пришлите его для диагностики.');
      } catch (error) {
        diagnostics.record('warn', 'COPY_FALLBACK', { error: safeError(error) });
        panel?.setLog(diagnostics.report());
        panel?.selectLog();
        panel?.copyMessage('Выделен текст лога — нажмите Ctrl+C и пришлите его.');
      }
    }

    function releaseLock() {
      if (ownedLock && doc.pointerLockElement === requestedElement) {
        try { doc.exitPointerLock?.(); } catch (_) { /* The page may have lost focus. */ }
      }
      ownedLock = false;
      requestedElement = null;
    }

    function stop(message = 'Камера снова прикреплена', reason = 'USER_STOP', errorCode = null) {
      if (!flight) return;
      const stoppedCamera = activeCamera;
      diagnostics.record(errorCode ? 'error' : 'info', 'CAMERA_STOP', {
        reason, activity: adapter?.activity?.() || null
      });
      win.cancelAnimationFrame(frame);
      lastSpeed = flight.speed;
      flight = null;
      held.clear();
      dragging = false;
      releaseLock();
      try { adapter?.detach(); } catch (error) {
        diagnostics.record('error', 'RESTORE_FAILED', { error: safeError(error) });
      }
      adapter = null;
      activeCamera = null;
      lastFrame = 0;
      failure = errorCode ? {
        camera: stoppedCamera, code: errorCode, message: `[${errorCode}] ${message}`
      } : null;
      display(failure?.message || message, false, Boolean(failure));
    }

    function tick(time) {
      if (!flight) return;
      try {
        if (!doc.hidden && !isEditing(doc.activeElement)) {
          stepFlight(flight, held, lastFrame ? (time - lastFrame) / 1000 : 0);
        }
        adapter.sync();
        framesSinceStart++;
        if (!activityReported && framesSinceStart >= 60) {
          const activity = adapter.activity();
          const used = activity.pivotUpdates > 0;
          diagnostics.record(used ? 'info' : 'warn', used ? 'CAMERA_HOOKS_USED' : 'CAMERA_HOOKS_IDLE', activity);
          activityReported = true;
        }
        lastFrame = time;
        frame = win.requestAnimationFrame(tick);
      } catch (error) {
        diagnostics.record('error', 'CAMERA_SYNC_FAILED', { error: safeError(error) });
        stop('Ошибка обновления камеры; скопируйте лог', 'SYNC_EXCEPTION', 'CAMERA_SYNC_FAILED');
      }
    }

    function toggle() {
      diagnostics.record('info', 'TOGGLE_REQUEST', {
        active: Boolean(flight), heldKeys: [...gameHeld]
      });
      if (flight) { stop(); return; }
      if (gameHeld.size) {
        failure = {
          camera: null, code: 'KEYS_HELD', message: '[KEYS_HELD] Сначала отпустите клавиши управления танком'
        };
        diagnostics.record('warn', 'KEYS_HELD', { heldKeys: [...gameHeld] });
        display(failure.message, false, true);
        return;
      }
      const trace = {};
      const found = resolveCamera(doc, trace);
      diagnostics.record(found.camera ? 'info' : 'warn', 'CAMERA_PROBE', { result: found.code, trace });
      if (!found.camera) {
        failure = { camera: null, code: found.code, message: found.message };
        display(found.message, false, true);
        return;
      }
      let stage = 'createFlight';
      try {
        const nextFlight = createFlight(found.camera, lastSpeed);
        stage = 'attachFreeCamera';
        const nextAdapter = attachFreeCamera(found.camera, nextFlight, error =>
          diagnostics.record('error', 'ROLLBACK_FAILED', { error }));
        stage = 'activate';
        flight = nextFlight;
        adapter = nextAdapter;
        activeCamera = found.camera;
        failure = null;
        held.clear();
        lastFrame = 0;
        framesSinceStart = 0;
        activityReported = false;
        firstMovementLogged = false;
        firstMouseLookLogged = false;
        diagnostics.record('info', 'CAMERA_ATTACHED', { hasPathControl: Boolean(
          'pathPosition_dl3fsr$_0' in found.camera || 'pathPosition' in found.camera
        ) });
        display(`Камера откреплена · ${Math.round(flight.speed)} ед/с`, true);
        frame = win.requestAnimationFrame(tick);
      } catch (error) {
        const explanation = scrubString(error?.message || 'Не удалось подключить камеру');
        diagnostics.record('error', 'ATTACH_FAILED', { stage, error: safeError(error) });
        if (flight) {
          // Even a failure after the hooks were installed (e.g. rAF) must undo them.
          stop(explanation, 'START_EXCEPTION', 'ATTACH_FAILED');
        } else {
          failure = { camera: found.camera, code: 'ATTACH_FAILED', message: `[ATTACH_FAILED] ${explanation}` };
          display(failure.message, false, true);
        }
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
        if (!firstMovementLogged && !event.repeat) {
          diagnostics.record('info', 'FIRST_CAMERA_KEY', { code: event.code });
          firstMovementLogged = true;
        }
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
              Promise.resolve(canvas.requestPointerLock()).catch(error => {
                diagnostics.record('warn', 'POINTER_LOCK_DENIED', { error: safeError(error) });
                if (requestedElement === canvas) requestedElement = null;
              });
            } catch (error) {
              diagnostics.record('warn', 'POINTER_LOCK_DENIED', { error: safeError(error) });
              requestedElement = null;
            }
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
      if (dragging) {
        lookFlight(flight, event.movementX || 0, event.movementY || 0);
        if (!firstMouseLookLogged) {
          diagnostics.record('info', 'FIRST_MOUSE_LOOK', { pointerLocked: Boolean(doc.pointerLockElement) });
          firstMouseLookLogged = true;
        }
      }
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
    win.addEventListener('pagehide', () => {
      stop('Камера снова прикреплена', 'PAGE_HIDE');
      win.clearInterval(checkTimer);
    });

    function mount() {
      if (panel || !doc.documentElement) return;
      panel = createPanel(doc, toggle, inspect, copyReport);
      display(flight ? `Камера откреплена · ${Math.round(flight.speed)} ед/с` :
        'Откройте бой, чтобы включить камеру', Boolean(flight));
    }
    mount();
    if (!panel) doc.addEventListener('DOMContentLoaded', mount, { once: true });
    const checkTimer = win.setInterval(() => {
      if (!panel) mount();
      const found = resolveCamera(doc);
      if (found.code !== lastProbeCode) {
        diagnostics.record('info', 'PROBE_STATE_CHANGED', { from: lastProbeCode, to: found.code });
        lastProbeCode = found.code;
      }
      if (flight && found.camera !== activeCamera) {
        diagnostics.record('warn', 'CAMERA_CHANGED', { currentProbe: found.code });
        stop('Бой или камера сменились; нажмите F8 после загрузки боя', 'BATTLE_CAMERA_CHANGED');
      } else if (!flight) {
        const sameFailure = failure && (
          (failure.camera && failure.camera === found.camera) ||
          (!failure.camera && failure.code === found.code) ||
          (failure.code === 'KEYS_HELD' && gameHeld.size > 0)
        );
        if (!sameFailure) failure = null;
        display(failure?.message || (found.camera ? 'Готово: нажмите F8 или кнопку' : found.message),
          false, Boolean(failure));
      }
    }, 1000);
  }

  // Export only the core for dependency-free Node tests; the installed
  // userscript starts directly in the game's page context (@grant none).
  if (typeof window === 'undefined' && typeof module !== 'undefined') {
    module.exports = {
      asArray, findStore, findLocalTank, findCameraInTank, isCompatibleCamera,
      cameraProblems, resolveCamera, createFlight, stepFlight, lookFlight,
      attachFreeCamera, createDiagnostics, safeError, bootstrap
    };
  } else {
    bootstrap(window);
  }
})();
