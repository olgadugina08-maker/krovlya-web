/* Импорт DWG: разбор через LibreDWG (WebAssembly) и растеризация в подложку */
(function () {
  const KP = window.KP;
  const VENDOR = 'vendor/libredwg/';

  let modulePromise = null;

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function report(callback, text) {
    if (typeof callback === 'function') callback(text);
    await delay(20);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const existing = document.querySelector('script[data-kp-dwg="' + src + '"]');
      if (existing) {
        if (existing.getAttribute('data-loaded') === '1') { resolve(); return; }
        existing.addEventListener('load', function () { resolve(); }, { once: true });
        existing.addEventListener('error', function () { reject(new Error('Не удалось загрузить ' + src)); }, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.setAttribute('data-kp-dwg', src);
      script.addEventListener('load', function () {
        script.setAttribute('data-loaded', '1');
        resolve();
      }, { once: true });
      script.addEventListener('error', function () {
        reject(new Error('Не удалось загрузить ' + src));
      }, { once: true });
      document.head.appendChild(script);
    });
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function gunzip(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Браузер не поддерживает распаковку WebAssembly. Откройте проект в Chrome, Edge или Firefox.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function getLibreDwg(onProgress) {
    if (modulePromise) return modulePromise;
    modulePromise = (async function () {
      await report(onProgress, 'Загрузка модуля чтения DWG…');
      await loadScript(VENDOR + 'libredwg-web-glue.js');
      await loadScript(VENDOR + 'libredwg-web.umd.js');
      await loadScript(VENDOR + 'libredwg-wasm-gzip.js');

      const ns = window['libredwg-web'];
      if (!ns || !ns.LibreDwg) {
        throw new Error('Модуль LibreDWG не загрузился.');
      }
      if (!window.LIBREDWG_WASM_GZIP) {
        throw new Error('Не найден файл libredwg-wasm-gzip.js.');
      }

      await report(onProgress, 'Подготовка вычислительного модуля…');
      const wasmBinary = await gunzip(base64ToBytes(window.LIBREDWG_WASM_GZIP));
      const wasmInstance = await window.createModule({ wasmBinary: wasmBinary });
      return ns.LibreDwg.createByWasmInstance(wasmInstance);
    })().catch(function (err) {
      modulePromise = null;
      throw err;
    });
    return modulePromise;
  }

  function readViewBox(svg) {
    const match = String(svg || '').match(/viewBox\s*=\s*"([^"]+)"/i);
    if (match) {
      const values = match[1].trim().split(/[,\s]+/).map(Number);
      if (values.length === 4 && values[2] > 0 && values[3] > 0) {
        return { x: values[0], y: values[1], width: values[2], height: values[3] };
      }
    }
    const widthMatch = String(svg || '').match(/\bwidth\s*=\s*"([\d.]+)"/i);
    const heightMatch = String(svg || '').match(/\bheight\s*=\s*"([\d.]+)"/i);
    const width = widthMatch ? Number(widthMatch[1]) : 1000;
    const height = heightMatch ? Number(heightMatch[1]) : 700;
    return { x: 0, y: 0, width: width > 0 ? width : 1000, height: height > 0 ? height : 700 };
  }

  function prepareSvg(svg, box, width, height) {
    return String(svg || '').replace(/<svg\b([^>]*)>/i, function (match, attrs) {
      const cleaned = attrs
        .replace(/\swidth\s*=\s*"[^"]*"/gi, '')
        .replace(/\sheight\s*=\s*"[^"]*"/gi, '')
        .replace(/\sviewBox\s*=\s*"[^"]*"/gi, '');
      return '<svg' + cleaned +
        ' viewBox="' + box.x + ' ' + box.y + ' ' + box.width + ' ' + box.height + '"' +
        ' width="' + width + '" height="' + height + '">';
    });
  }

  function fitSize(box, limit) {
    const ratio = box.height / box.width;
    let width = limit;
    let height = Math.round(limit * ratio);
    if (height > limit) {
      height = limit;
      width = Math.round(limit / ratio);
    }
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }

  function renderSvg(svg, box, width, height) {
    return new Promise(function (resolve, reject) {
      const blob = new Blob([prepareSvg(svg, box, width, height)], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const image = new Image();

      image.onload = function () {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        resolve(canvas);
      };

      image.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Не удалось отрисовать чертёж DWG.'));
      };

      image.src = url;
    });
  }

  function isInk(r, g, b, a) {
    if (a <= 8) return false;
    // Белая заливка/фон не считается содержимым чертежа.
    return !(r > 242 && g > 242 && b > 242);
  }

  function contentBounds(canvas) {
    const ctx = canvas.getContext('2d');
    let data;
    try {
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (err) {
      return null;
    }

    const xs = [];
    const ys = [];
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const index = (y * canvas.width + x) * 4;
        if (isInk(data[index], data[index + 1], data[index + 2], data[index + 3])) {
          xs.push(x);
          ys.push(y);
        }
      }
    }
    if (xs.length < 20) return null;

    xs.sort(function (a, b) { return a - b; });
    ys.sort(function (a, b) { return a - b; });
    const quantile = function (array, part) {
      return array[Math.min(array.length - 1, Math.floor(array.length * part))];
    };

    // Отбрасываем 2% самых удалённых пикселей — рамки листа и одиночные выноски.
    let minX = quantile(xs, 0.02);
    let maxX = quantile(xs, 0.98);
    let minY = quantile(ys, 0.02);
    let maxY = quantile(ys, 0.98);
    const marginX = Math.max(4, (maxX - minX) * 0.05);
    const marginY = Math.max(4, (maxY - minY) * 0.05);

    minX = Math.max(0, minX - marginX);
    maxX = Math.min(canvas.width - 1, maxX + marginX);
    minY = Math.max(0, minY - marginY);
    maxY = Math.min(canvas.height - 1, maxY + marginY);

    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  function clearWhite(canvas) {
    const ctx = canvas.getContext('2d');
    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (err) {
      return;
    }
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 242 && data[i + 1] > 242 && data[i + 2] > 242) {
        data[i + 3] = 0;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }

  async function rasterize(svg, maxSize) {
    const fullBox = readViewBox(svg);
    const limit = maxSize || 2000;

    // Первый проход — находим реальные границы чертежа и отбрасываем пустые поля.
    const probe = fitSize(fullBox, 1200);
    const probeCanvas = await renderSvg(svg, fullBox, probe.width, probe.height);
    const visible = contentBounds(probeCanvas);

    let box = fullBox;
    if (visible && visible.width > 2 && visible.height > 2 &&
        visible.width * visible.height < probe.width * probe.height * 0.9) {
      const scaleX = fullBox.width / probe.width;
      const scaleY = fullBox.height / probe.height;
      const marginX = Math.max(fullBox.width * 0.002, visible.width * scaleX * 0.03);
      const marginY = Math.max(fullBox.height * 0.002, visible.height * scaleY * 0.03);
      box = {
        x: fullBox.x + visible.x * scaleX - marginX,
        y: fullBox.y + visible.y * scaleY - marginY,
        width: visible.width * scaleX + marginX * 2,
        height: visible.height * scaleY + marginY * 2
      };
    }

    const size = fitSize(box, limit);
    const canvas = await renderSvg(svg, box, size.width, size.height);
    clearWhite(canvas);

    let dataUrl;
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch (err) {
      throw err;
    }

    // Слишком большая PNG — сохраняем как JPEG с белым фоном.
    if (dataUrl.length > 2500000) {
      const flat = document.createElement('canvas');
      flat.width = size.width;
      flat.height = size.height;
      const flatCtx = flat.getContext('2d');
      flatCtx.fillStyle = '#ffffff';
      flatCtx.fillRect(0, 0, size.width, size.height);
      flatCtx.drawImage(canvas, 0, 0);
      dataUrl = flat.toDataURL('image/jpeg', 0.85);
    }

    return {
      dataUrl: dataUrl,
      width: size.width,
      height: size.height,
      viewBox: box,
      raster: true,
      debug: {
        fullBox: fullBox,
        visible: visible,
        probe: probe
      }
    };
  }

  /* ---------- преобразование сущностей DWG в редактируемые объекты ---------- */

  function identity() {
    return [1, 0, 0, 1, 0, 0];
  }

  function multiplyMatrix(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

  function applyMatrix(m, point) {
    return {
      x: m[0] * point.x + m[2] * point.y + m[4],
      y: m[1] * point.x + m[3] * point.y + m[5]
    };
  }

  function matrixScale(m) {
    return Math.max(1e-9, Math.hypot(m[0], m[1]));
  }

  function translation(x, y) { return [1, 0, 0, 1, x, y]; }
  function rotation(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [c, s, -s, c, 0, 0];
  }
  function scaling(x, y) { return [x, 0, 0, y, 0, 0]; }

  function cleanDwgText(value) {
    return String(value == null ? '' : value)
      .replace(/\\P/gi, ' ')
      .replace(/\\[A-Za-z][^;\\]*;/g, '')
      .replace(/%%d/gi, '°')
      .replace(/%%p/gi, '±')
      .replace(/%%c/gi, 'Ø')
      .replace(/[{}]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function aciColor(index) {
    const palette = {
      1: '#c0392b', 2: '#c9a227', 3: '#2e8b57', 4: '#2f9f9f',
      5: '#2f6f9f', 6: '#9b59b6', 7: '#272727', 8: '#7f8c8d', 9: '#95a5a6'
    };
    return palette[index] || '#2f6f9f';
  }

  function finitePoints(points) {
    return (points || []).filter(function (p) {
      return p && Number.isFinite(p.x) && Number.isFinite(p.y);
    });
  }

  function objectColor(entity) {
    if (entity && entity.colorIndex != null && entity.colorIndex > 0 && entity.colorIndex < 256) {
      return aciColor(entity.colorIndex);
    }
    return '#2f6f9f';
  }

  function bulgeArcPoints(from, to, bulge) {
    if (!bulge) return [];
    const theta = Math.atan(bulge) * 4;
    const a = bulge < 0 ? { x: from.x, y: from.y } : { x: to.x, y: to.y };
    const b = bulge < 0 ? { x: to.x, y: to.y } : { x: from.x, y: from.y };
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len = Math.hypot(abx, aby);
    if (!(len > 1e-9)) return [];
    const cx = a.x + abx / 2;
    const cy = a.y + aby / 2;
    const dist = Math.abs(len / 2 / Math.tan(theta / 2));
    const nx = abx / len;
    const ny = aby / len;
    const rx = -ny;
    const ry = nx;
    const dir = theta < Math.PI ? -1 : 1;
    const ox = cx + rx * dist * dir;
    const oy = cy + ry * dist * dir;
    const radius = Math.hypot(b.x - ox, b.y - oy);
    let start = Math.atan2(b.y - oy, b.x - ox) * 180 / Math.PI;
    let end = Math.atan2(a.y - oy, a.x - ox) * 180 / Math.PI;
    if (end < start) end += 360;
    const result = [];
    for (let angle = Math.ceil(start / 10) * 10; angle <= end; angle += 10) {
      const rad = angle * Math.PI / 180;
      result.push({ x: ox + Math.cos(rad) * radius, y: oy + Math.sin(rad) * radius });
    }
    if (bulge < 0) result.reverse();
    return result;
  }

  function polylinePoints(vertices, closed) {
    const result = [];
    if (!Array.isArray(vertices) || !vertices.length) return result;
    const count = vertices.length;
    for (let i = 0; i < count; i++) {
      const current = vertices[i];
      result.push({ x: current.x, y: current.y });
      const hasNext = i < count - 1 || closed;
      if (hasNext && current.bulge) {
        const next = vertices[(i + 1) % count];
        bulgeArcPoints(current, next, current.bulge).forEach(function (p) { result.push(p); });
      }
    }
    return result;
  }

  function sampleArc(cx, cy, radius, startAngle, endAngle, segments) {
    let start = Number(startAngle) || 0;
    let end = Number(endAngle) || 0;
    let sweep = end - start;
    if (sweep <= 0) sweep += Math.PI * 2;
    const count = Math.max(6, segments || Math.ceil(sweep / (Math.PI / 24)));
    const points = [];
    for (let i = 0; i <= count; i++) {
      const angle = start + sweep * i / count;
      points.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
    }
    return points;
  }

  function sampleEllipse(entity, segments) {
    const center = entity.center || { x: 0, y: 0 };
    const major = entity.majorAxisEndPoint || { x: 1, y: 0 };
    const rx = Math.hypot(major.x, major.y);
    const ry = rx * (Number(entity.axisRatio) || 1);
    const rot = Math.atan2(major.y, major.x);
    let start = Number(entity.startAngle);
    let end = Number(entity.endAngle);
    if (!Number.isFinite(start) || !Number.isFinite(end)) { start = 0; end = Math.PI * 2; }
    let sweep = end - start;
    if (Math.abs(sweep) < 1e-9) sweep = Math.PI * 2;
    if (sweep < 0) sweep += Math.PI * 2;
    const count = Math.max(12, segments || Math.ceil(Math.abs(sweep) / (Math.PI / 32)));
    const points = [];
    for (let i = 0; i <= count; i++) {
      const angle = start + sweep * i / count;
      const localX = Math.cos(angle) * rx;
      const localY = Math.sin(angle) * ry;
      points.push({
        x: center.x + localX * Math.cos(rot) - localY * Math.sin(rot),
        y: center.y + localX * Math.sin(rot) + localY * Math.cos(rot)
      });
    }
    return points;
  }

  function modelSpace(database) {
    const blocks = database && database.tables && database.tables.BLOCK_RECORD &&
      database.tables.BLOCK_RECORD.entries ? database.tables.BLOCK_RECORD.entries : [];
    let model = null;
    const map = new Map();
    blocks.forEach(function (block) {
      const name = String(block.name || '').toUpperCase();
      map.set(name, block);
      if (name === '*MODEL_SPACE') model = block;
    });
    return {
      entities: model && Array.isArray(model.entities) ? model.entities : (database.entities || []),
      blocks: map
    };
  }

  function collectRawObjects(entities, matrix, blocks, out, stats, depth) {
    if (depth > 6 || !Array.isArray(entities)) return;

    entities.forEach(function (entity) {
      if (!entity || !entity.type) return;
      const type = String(entity.type).toUpperCase();
      stats[type] = (stats[type] || 0) + 1;

      if (type === 'INSERT') {
        const block = blocks.get(String(entity.name || '').toUpperCase());
        if (!block || !Array.isArray(block.entities)) return;
        const insertion = entity.insertionPoint || { x: 0, y: 0 };
        const base = block.basePoint || { x: 0, y: 0 };
        const cols = Math.max(1, Number(entity.columnCount) || 1);
        const rows = Math.max(1, Number(entity.rowCount) || 1);
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const offsetX = col * (Number(entity.columnSpacing) || 0);
            const offsetY = row * (Number(entity.rowSpacing) || 0);
            const local = multiplyMatrix(
              multiplyMatrix(
                multiplyMatrix(
                  translation(insertion.x + offsetX, insertion.y + offsetY),
                  rotation(Number(entity.rotation) || 0)
                ),
                scaling(Number(entity.xScale) || 1, Number(entity.yScale) || 1)
              ),
              translation(-base.x, -base.y)
            );
            collectRawObjects(block.entities, multiplyMatrix(matrix, local), blocks, out, stats, depth + 1);
          }
        }
        return;
      }

      if (type === 'DIMENSION' && entity.name && blocks.has(String(entity.name).toUpperCase())) {
        const block = blocks.get(String(entity.name).toUpperCase());
        if (block && Array.isArray(block.entities)) {
          collectRawObjects(block.entities, matrix, blocks, out, stats, depth + 1);
        }
        return;
      }

      const localScale = matrixScale(matrix);
      const layer = entity.layer || '0';
      const color = objectColor(entity);

      if (type === 'LINE') {
        if (!entity.startPoint || !entity.endPoint) return;
        const points = finitePoints([
          applyMatrix(matrix, entity.startPoint),
          applyMatrix(matrix, entity.endPoint)
        ]);
        if (points.length === 2) {
          out.push({ kind: 'line', layer: layer, color: color, points: points });
        }
      } else if (type === 'LWPOLYLINE' || type === 'POLYLINE') {
        let closed = !!(Number(entity.flag) & 1) || !!(Number(entity.flag) & 512);
        const rawPoints = finitePoints(polylinePoints(entity.vertices, closed));
        if (!closed && rawPoints.length >= 3) {
          const first = rawPoints[0];
          const last = rawPoints[rawPoints.length - 1];
          const xs = rawPoints.map(function (p) { return p.x; });
          const ys = rawPoints.map(function (p) { return p.y; });
          const diagonal = Math.hypot(
            Math.max.apply(null, xs) - Math.min.apply(null, xs),
            Math.max.apply(null, ys) - Math.min.apply(null, ys)
          );
          const gap = Math.hypot(first.x - last.x, first.y - last.y);
          if (gap <= Math.max(1e-6, diagonal * 0.002)) closed = true;
        }
        const points = finitePoints(rawPoints.map(function (p) { return applyMatrix(matrix, p); }));
        if (points.length >= 2) {
          out.push({ kind: 'polyline', layer: layer, color: color, closed: closed, points: points });
        }
      } else if (type === 'CIRCLE') {
        if (!entity.center || !(Number(entity.radius) > 0)) return;
        const center = applyMatrix(matrix, entity.center);
        out.push({
          kind: 'circle',
          layer: layer,
          color: color,
          cx: center.x,
          cy: center.y,
          r: Number(entity.radius) * localScale
        });
      } else if (type === 'ARC') {
        if (!entity.center || !(Number(entity.radius) > 0)) return;
        const points = finitePoints(sampleArc(
          Number(entity.center.x), Number(entity.center.y),
          Number(entity.radius), entity.startAngle, entity.endAngle
        ).map(function (p) { return applyMatrix(matrix, p); }));
        if (points.length >= 2) {
          out.push({ kind: 'polyline', layer: layer, color: color, closed: false, points: points });
        }
      } else if (type === 'ELLIPSE') {
        const points = finitePoints(sampleEllipse(entity).map(function (p) { return applyMatrix(matrix, p); }));
        if (points.length >= 2) {
          out.push({ kind: 'polyline', layer: layer, color: color, closed: true, points: points });
        }
      } else if (type === 'SPLINE') {
        const points = finitePoints((entity.controlPoints || [])
          .map(function (p) { return applyMatrix(matrix, p); }));
        if (points.length >= 2) {
          out.push({ kind: 'polyline', layer: layer, color: color, closed: false, points: points });
        }
      } else if (type === 'SOLID' || type === 'TRACE' || type === '3DFACE') {
        const points = finitePoints((entity.points || entity.corners || [])
          .filter(Boolean)
          .map(function (p) { return applyMatrix(matrix, p); }));
        if (points.length >= 3) {
          out.push({ kind: 'polyline', layer: layer, color: color, closed: true, points: points });
        }
      } else if (type === 'TEXT' || type === 'MTEXT') {
        const text = cleanDwgText(entity.text);
        if (!text) return;
        const insertion = type === 'TEXT' ? entity.startPoint : entity.insertionPoint;
        if (!insertion) return;
        const point = applyMatrix(matrix, insertion);
        const angle = Math.atan2(matrix[1], matrix[0]) + (Number(entity.rotation) || 0);
        out.push({
          kind: 'text',
          layer: layer,
          color: '#333333',
          x: point.x,
          y: point.y,
          text: text,
          height: Math.max(0.05, (Number(entity.textHeight) || 2.5) * localScale),
          rotation: -angle * 180 / Math.PI
        });
      }
    });
  }

  function objectBounds(objects) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = function (x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };
    objects.forEach(function (obj) {
      if (obj.kind === 'circle') {
        add(obj.cx - obj.r, obj.cy - obj.r);
        add(obj.cx + obj.r, obj.cy + obj.r);
      } else if (obj.kind === 'text') {
        add(obj.x, obj.y - obj.height);
        add(obj.x + obj.text.length * obj.height * 0.62, obj.y + obj.height * 0.3);
      } else {
        (obj.points || []).forEach(function (p) { add(p.x, p.y); });
      }
    });
    if (!Number.isFinite(minX)) return null;
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  function buildObjects(database, options) {
    const opts = options || {};
    const space = modelSpace(database);
    const raw = [];
    const stats = {};
    collectRawObjects(space.entities, identity(), space.blocks, raw, stats, 0);

    if (!raw.length) {
      throw new Error('В модели DWG не найдено поддерживаемых объектов для редактирования.');
    }

    const bounds = objectBounds(raw);
    if (!bounds) throw new Error('Не удалось определить границы чертежа.');

    const width = Math.max(1e-6, bounds.maxX - bounds.minX);
    const height = Math.max(1e-6, bounds.maxY - bounds.minY);
    const maxDim = Math.max(width, height);
    const unit = opts.unit || 'auto';
    let scale = 1;
    if (unit === 'mm') scale = 0.001;
    else if (unit === 'cm') scale = 0.01;
    else if (unit === 'm') scale = 1;
    else {
      const target = Number(opts.targetWidth) || 60;
      scale = target / maxDim;
    }

    const mapPoint = function (p) {
      return {
        x: Number(((p.x - bounds.minX) * scale).toFixed(3)),
        y: Number(((bounds.maxY - p.y) * scale).toFixed(3))
      };
    };

    const objects = raw.map(function (obj) {
      const result = {
        id: KP.uid('obj'),
        kind: obj.kind,
        layer: obj.layer || '0',
        color: obj.color || '#2f6f9f'
      };
      if (obj.kind === 'circle') {
        const center = mapPoint({ x: obj.cx, y: obj.cy });
        result.cx = center.x;
        result.cy = center.y;
        result.r = Number((obj.r * scale).toFixed(3));
      } else if (obj.kind === 'text') {
        const point = mapPoint({ x: obj.x, y: obj.y });
        result.x = point.x;
        result.y = point.y;
        result.text = obj.text;
        result.height = Number((obj.height * scale).toFixed(3));
        result.rotation = Number((obj.rotation || 0).toFixed(2));
      } else {
        result.closed = !!obj.closed;
        result.points = obj.points.map(mapPoint);
      }
      return result;
    }).filter(function (obj) {
      if (obj.kind === 'circle') return obj.r > 0;
      if (obj.kind === 'text') return obj.text && obj.text.length > 0;
      return obj.points && obj.points.length >= 2;
    });

    return {
      mode: 'objects',
      objects: objects,
      bounds: {
        width: Number((width * scale).toFixed(3)),
        height: Number((height * scale).toFixed(3))
      },
      scale: scale,
      unit: unit,
      counts: stats,
      total: raw.length,
      modelEntities: space.entities.length,
      supported: objects.length
    };
  }

  async function importFile(file, onProgress, options) {
    if (!file) throw new Error('Файл не выбран.');
    if (!/\.dwg$/i.test(file.name || '')) {
      throw new Error('Выберите файл с расширением .dwg.');
    }

    const opts = options || {};
    const mode = opts.mode === 'underlay' ? 'underlay' : 'objects';
    const libredwg = await getLibreDwg(onProgress);

    await report(onProgress, 'Чтение файла ' + file.name + '…');
    const buffer = await file.arrayBuffer();

    await report(onProgress, 'Разбор DWG…');
    const dataPtr = libredwg.dwg_read_data(buffer, 0);
    if (!dataPtr) {
      throw new Error('LibreDWG не смог прочитать файл. Возможно, файл повреждён или имеет неподдерживаемую версию.');
    }

    let database = null;
    try {
      await report(onProgress, mode === 'objects' ? 'Преобразование объектов…' : 'Преобразование чертежа…');
      database = libredwg.convert(dataPtr);
    } finally {
      try { libredwg.dwg_free(dataPtr); } catch (err) { /* ignore */ }
    }

    if (!database) throw new Error('Не удалось преобразовать данные DWG.');

    if (mode === 'objects') {
      return buildObjects(database, opts);
    }

    const counts = {};
    const entities = Array.isArray(database.entities) ? database.entities : [];
    entities.forEach(function (entity) {
      const type = entity && entity.type ? entity.type : 'UNKNOWN';
      counts[type] = (counts[type] || 0) + 1;
    });

    await report(onProgress, 'Построение SVG…');
    const svg = libredwg.dwg_to_svg(database);
    if (!svg) throw new Error('Не удалось получить геометрию чертежа.');

    const viewBox = readViewBox(svg);
    if (!(viewBox.width > 0) || !(viewBox.height > 0)) {
      throw new Error('В чертеже не найдена геометрия модели.');
    }

    await report(onProgress, 'Растеризация чертежа…');
    let raster;
    try {
      raster = await rasterize(svg, 2000);
    } catch (err) {
      // Если SVG содержит внешние ссылки и canvas «испорчен», используем SVG как подложку.
      raster = {
        dataUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
        width: 2000,
        height: Math.round(2000 * viewBox.height / viewBox.width),
        viewBox: viewBox,
        raster: false
      };
    }

    return {
      mode: 'underlay',
      dataUrl: raster.dataUrl,
      width: raster.width,
      height: raster.height,
      raster: raster.raster,
      viewBox: raster.viewBox || viewBox,
      counts: counts,
      total: entities.length,
      source: 'dwg',
      debug: raster.debug || null
    };
  }

  KP.dwg = {
    importFile: importFile,
    readViewBox: readViewBox,
    isModuleLoaded: function () { return !!modulePromise; }
  };
})();
